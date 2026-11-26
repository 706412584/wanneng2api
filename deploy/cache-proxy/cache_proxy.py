#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
灵犀请求去重缓存代理 (127.0.0.1:6791 → 127.0.0.1:6789)
- 对请求体做 SHA256 指纹,相同指纹直接返回 Redis 缓存的响应(跳过上游 prefill)
- 不同指纹转发到灵犀,拿到响应后写 Redis 再返回
- 支持流式(SSE)与非流式响应的缓存与重放
- 零第三方依赖(内置 http.server + socket 直连 Redis RESP 协议)
"""
import hashlib, json, socket, sys, time, threading, logging
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen

REDIS_HOST, REDIS_PORT = "127.0.0.1", 6379
UPSTREAM = "http://127.0.0.1:6789"
CACHE_TTL = 300          # 缓存 5 分钟
MAX_BODY = 64 * 1024 * 1024
LOG = logging.getLogger("cache-proxy")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")

def redis_cmd(sock, *args):
    """发送 RESP 命令并读取响应(仅支持 GET/SETEX/DEL 简单场景)"""
    def enc(b):
        return b if isinstance(b, bytes) else str(b).encode()
    out = [b"*" + str(len(args)).encode() + b"\r\n"]
    for a in args:
        b = enc(a)
        out += [b"$" + str(len(b)).encode() + b"\r\n", b, b"\r\n"]
    sock.sendall(b"".join(out))
    buf = b""
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError("redis closed")
        buf += chunk
        if buf.endswith(b"\r\n"):
            break
    return buf

def redis_get(key):
    s = socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=2)
    try:
        r = redis_cmd(s, "GET", key)
        if r.startswith(b"$-1"):
            return None
        parts = r.split(b"\r\n", 2)
        return parts[1] if len(parts) >= 2 else None
    finally:
        s.close()

def redis_setex(key, ttl, val):
    s = socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=2)
    try:
        redis_cmd(s, "SETEX", key, str(ttl), val)
    finally:
        s.close()

def fingerprint(body_bytes):
    """对请求体做语义指纹:model+messages+tools+stream+max_tokens+temperature"""
    try:
        d = json.loads(body_bytes)
        core = {
            "m": d.get("model"),
            "msg": d.get("messages"),
            "tools": d.get("tools"),
            "stream": d.get("stream"),
            "max_tokens": d.get("max_tokens") or d.get("max_completion_tokens"),
            "temperature": d.get("temperature"),
        }
        return hashlib.sha256(json.dumps(core, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    except Exception:
        return hashlib.sha256(body_bytes).hexdigest()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        pass

    def _forward(self, body, headers):
        req = Request(UPSTREAM + self.path, data=body, method="POST")
        # 原样透传所有请求头,只排除连接级/传输级头(由 urllib 自动处理)
        skip = {"host", "content-length", "connection", "accept-encoding"}
        for k, v in headers.items():
            if k.lower() in skip:
                continue
            req.add_header(k, v)
        # Content-Type 透传原始值(不强制覆盖),客户端没传才补默认
        if not headers.get("Content-Type"):
            req.add_header("Content-Type", "application/json")
        return urlopen(req, timeout=300)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        fp = fingerprint(body)
        cache_key = "wbcache:" + fp

        # 1. 查缓存
        try:
            cached = redis_get(cache_key)
        except Exception as e:
            cached = None
            LOG.warn("redis get fail: %s", e)

        if cached:
            try:
                obj = json.loads(cached)
                payload = obj["body"]
                is_stream = obj.get("stream", False)
                LOG.info("HIT %s stream=%s", fp[:12], is_stream)
                self.send_response(200)
                self.send_header("Content-Type", "application/json" if not is_stream else "text/event-stream")
                self.send_header("X-Cache", "HIT")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload.encode() if isinstance(payload, str) else payload)
                return
            except Exception as e:
                LOG.warn("cache parse fail: %s", e)

        # 2. 未命中,转发上游
        try:
            resp = self._forward(body, self.headers)
            raw = resp.read()
            status = resp.status
            content_type = resp.headers.get("Content-Type", "application/json")
        except Exception as e:
            LOG.error("upstream fail: %s", e)
            self.send_error(502, str(e))
            return

        # 3. 写缓存(仅 200 成功才缓存)
        if status == 200:
            try:
                is_stream = "text/event-stream" in content_type or self._is_sse(raw)
                obj = {"body": raw.decode("utf-8", "ignore"), "stream": is_stream, "ts": time.time()}
                redis_setex(cache_key, CACHE_TTL, json.dumps(obj, ensure_ascii=False))
                LOG.info("MISS %s cached(%dB) stream=%s", fp[:12], len(raw), is_stream)
            except Exception as e:
                LOG.warn("cache write fail: %s", e)

        # 4. 返回给客户端
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Cache", "MISS")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _is_sse(self, raw):
        return raw.startswith(b"data:") or b"\ndata:" in raw[:200]

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_error(404)

def run():
    srv = HTTPServer(("127.0.0.1", 6791), Handler)
    LOG.info("cache proxy listening on 127.0.0.1:6791 -> 127.0.0.1:6789, ttl=%ds", CACHE_TTL)
    srv.serve_forever()

if __name__ == "__main__":
    run()
