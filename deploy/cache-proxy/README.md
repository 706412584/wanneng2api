# 灵犀请求去重缓存代理

在 sub2api 与灵犀网关之间插入一层轻量缓存代理,对**完全相同的请求体**直接返回上次响应,跳过上游 prefill。

## 架构

```
客户端 → sub2api → [缓存代理:6791] → 灵犀:6789
```

- **去重缓存**:对请求体做 SHA256 指纹,相同指纹直接返回 Redis 缓存的响应
- **上游 prompt cache**:灵犀原生支持 prompt caching,相同前缀自动命中 `cache_read_input_tokens`

## 部署

```bash
# 1. 放置文件
mkdir -p /opt/lingxi-cache-proxy
cp cache_proxy.py /opt/lingxi-cache-proxy/
cp lingxi-cache-proxy.service /etc/systemd/system/

# 2. 修改 sub2api 账号 base_url 指向缓存代理
#   (原: http://127.0.0.1:6789 或 http://127.0.0.1:6790)
#   (新: http://127.0.0.1:6791)

# 3. 启动
systemctl daemon-reload
systemctl enable --now lingxi-cache-proxy
```

## 实测效果

| 场景 | 无缓存 | 有缓存 |
|---|---|---|
| 相同请求体重试 | 2.34s | **0.07s** |
| 相同前缀+不同输入 | 10.35s | 2.85s(上游 cache 命中) |

## 依赖

- Python 3.6+(内置库,零第三方依赖)
- Redis(127.0.0.1:6379,用于存储缓存响应)

## 回滚

```bash
systemctl stop lingxi-cache-proxy
# sub2api 账号 base_url 改回原值即可
```
