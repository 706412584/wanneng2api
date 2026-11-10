'use strict';
// pg-initdb-stub.js — 伪装 initdb：-D <dir> 时创建 PG_VERSION + postgresql.conf
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const di = args.indexOf('-D');
if (di >= 0) {
  const dir = args[di + 1];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'PG_VERSION'), '15\n');
  fs.writeFileSync(path.join(dir, 'postgresql.conf'), "# stub conf\n");
}
process.stdout.write('initdb stub: ok\n');
process.exit(0);
