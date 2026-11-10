'use strict';
// mock-crash.js — 秒退模拟 crash：stdout 打一行后立刻退出（退出码 1）
const port = process.env.MOCK_PORT || 0;
console.log(`mock-crash starting, would use port ${port}`);
setTimeout(() => {
  console.log('mock-crash exiting');
  process.exit(1);
}, 300);
