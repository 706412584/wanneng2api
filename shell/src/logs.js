'use strict';
/**
 * logs.js — 轮转日志 + 环形缓冲（纯 Node 模块，无 Electron 依赖）
 *
 * - RotatingFileWriter: 追加写文件，超过 maxBytes 时轮转
 *   <name>.log → <name>.log.1 → ... → <name>.log.<keepN>（编号越大越旧，最旧丢弃）
 * - RingBuffer: 固定容量环形缓冲，供 UI SSE 实时推送与 tail 查询
 *
 * 线程模型：单进程 Node，同步 appendFile 足够（低频日志）。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/** 环形缓冲：保存最近 capacity 行 */
class RingBuffer extends EventEmitter {
  constructor(capacity = 500) {
    super();
    this.capacity = capacity;
    this.items = [];
    this.setMaxListeners(200); // 多个 SSE 订阅者
  }

  push(line) {
    this.items.push(line);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
    this.emit('line', line);
  }

  /** 最近 N 行（按时间正序），N<=0 返回全部 */
  tail(n = 200) {
    const arr = this.items;
    if (!n || n <= 0 || n >= arr.length) return arr.slice();
    return arr.slice(arr.length - n);
  }

  get size() {
    return this.items.length;
  }

  clear() {
    this.items = [];
  }
}

/**
 * 轮转文件写入器。
 * rotateBytes 超限时：log.4 删 → log.3→log.4 → ... → log→log.1 → 新建 log
 */
class RotatingFileWriter {
  constructor(filePath, { rotateBytes = 10 * 1024 * 1024, keepFiles = 5 } = {}) {
    this.filePath = filePath;
    this.rotateBytes = rotateBytes;
    this.keepFiles = keepFiles;
    this.bytesWritten = 0;
    this._checked = false;
    this._open();
  }

  _open() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath)) {
        this.bytesWritten = fs.statSync(this.filePath).size;
      } else {
        this.bytesWritten = 0;
        fs.writeFileSync(this.filePath, '', { flag: 'wx' });
      }
      this._checked = true;
    } catch (_e) {
      // 目录不可写等极端情况：降级为丢弃日志，不影响主流程
      this._checked = false;
    }
  }

  _rotate() {
    try {
      const oldest = `${this.filePath}.${this.keepFiles}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let i = this.keepFiles - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        const to = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.filePath, `${this.filePath}.1`);
      fs.writeFileSync(this.filePath, '');
      this.bytesWritten = 0;
    } catch (_e) {
      // 轮转失败（文件被占用等）：继续尝试追加
    }
  }

  write(line) {
    const data = line.endsWith('\n') ? line : line + '\n';
    if (this._checked && this.bytesWritten + Buffer.byteLength(data) > this.rotateBytes) {
      this._rotate();
    }
    try {
      fs.appendFileSync(this.filePath, data);
      this.bytesWritten += Buffer.byteLength(data);
    } catch (_e) {
      this._checked = false; // 下次 write 重新 _open
      try { this._open(); fs.appendFileSync(this.filePath, data); } catch (_e2) { /* 丢弃 */ }
    }
  }

  flush() { /* appendFileSync 同步落盘，无需额外 flush */ }

  close() { this.flush(); }
}

module.exports = { RingBuffer, RotatingFileWriter };
