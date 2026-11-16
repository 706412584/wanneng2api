'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TunnelStore } = require('../src/tunnel/tunnel-store');
const { parseNamedTokenInfo, tokenFingerprint } = require('../src/tunnel/targets');

function makeToken(tunnelId) {
  return Buffer.from(JSON.stringify({ a: 'account-id', t: tunnelId, s: 'secret' })).toString('base64url');
}
const TOKEN_A = makeToken('tunnel-a');
const TOKEN_B = makeToken('tunnel-b');
const NEW_TOKEN = makeToken('tunnel-new');

function expectCode(code, fn) {
  assert.throws(fn, (error) => error && error.code === code, `应抛出 ${code}`);
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-tunnel-store-'));
  try {
    assert.deepStrictEqual(parseNamedTokenInfo(TOKEN_A), { tunnelId: 'tunnel-a' });
    assert.strictEqual(tokenFingerprint(TOKEN_A).length, 64);
    expectCode('INVALID_TOKEN', () => parseNamedTokenInfo('not-a-token'));
    expectCode('INVALID_TOKEN', () => parseNamedTokenInfo(Buffer.from('{"t":"only"}').toString('base64url')));

    const store = new TunnelStore(root);
    assert.strictEqual(store.list().length, 6);
    assert.strictEqual(store.get('workbuddy').guardPort, 17901);
    assert.strictEqual(store.get('manager').passwordConfigured, false);
    assert.strictEqual(store.get('workbuddy').verifiedAt, 0);

    store.updateTarget('workbuddy', {
      mode: 'named', publicUrl: 'https://WB.example.com/', token: TOKEN_A, autoStart: true,
    });
    assert.strictEqual(store.get('workbuddy').publicUrl, 'https://wb.example.com');
    assert.strictEqual(store.get('workbuddy').hasToken, true);
    assert.strictEqual(store.getToken('workbuddy'), TOKEN_A);
    expectCode('TOKEN_VERIFICATION_REQUIRED', () => store.getStartConfig('workbuddy'));
    store.markTokenVerified('workbuddy', {
      token: TOKEN_A, tunnelId: 'tunnel-a', expectedUpdatedAt: store.get('workbuddy').updatedAt,
    });
    assert.strictEqual(store.getStartConfig('workbuddy').token, TOKEN_A);
    assert.strictEqual(store.get('workbuddy').tunnelId, 'tunnel-a');
    assert.ok(store.get('workbuddy').verifiedAt > 0);
    const publicText = fs.readFileSync(store.publicPath, 'utf8');
    assert.ok(!publicText.includes(TOKEN_A), 'Token 不得进入公共配置');
    assert.ok(!JSON.stringify(store.list()).includes(TOKEN_A), 'Token 不得进入快照');
    assert.ok(!JSON.stringify(store.list()).includes('fingerprint'), '指纹不得进入快照');

    expectCode('DUPLICATE_TOKEN', () => store.updateTarget('codearts', {
      mode: 'named', publicUrl: 'https://ca.example.com', token: TOKEN_A,
    }));
    expectCode('DUPLICATE_PUBLIC_URL', () => store.updateTarget('codearts', {
      mode: 'named', publicUrl: 'https://wb.example.com', token: TOKEN_B,
    }));
    expectCode('DUPLICATE_GUARD_PORT', () => store.updateTarget('codearts', { guardPort: 17901 }));
    expectCode('INVALID_PUBLIC_URL', () => store.updateTarget('workbuddy', { publicUrl: 'http://wb.example.com' }));
    expectCode('INVALID_PUBLIC_URL', () => store.updateTarget('workbuddy', { publicUrl: 'https://wb.example.com/path' }));
    expectCode('INVALID_MODE', () => store.updateTarget('workbuddy', { mode: 'other' }));
    expectCode('INVALID_GUARD_PORT', () => store.updateTarget('workbuddy', { guardPort: 80 }));
    expectCode('UNKNOWN_TARGET', () => store.get('other'));

    store.updateTarget('workbuddy', { autoStart: false });
    assert.strictEqual(store.getToken('workbuddy'), TOKEN_A, '省略 Token 应保持不变');
    assert.ok(store.get('workbuddy').verifiedAt > 0, '非 Token 配置变化应保留验证');
    store.updateTarget('workbuddy', { token: TOKEN_B });
    assert.strictEqual(store.get('workbuddy').verifiedAt, 0, '修改 Token 必须使旧验证失效');
    store.markTokenVerified('workbuddy', {
      token: TOKEN_B, tunnelId: 'tunnel-b', expectedUpdatedAt: store.get('workbuddy').updatedAt,
    });
    const verifiedAt = store.get('workbuddy').verifiedAt;
    store.updateTarget('workbuddy', { token: TOKEN_B });
    assert.strictEqual(store.get('workbuddy').verifiedAt, verifiedAt, '同值 Token 应保留验证');
    store.updateTarget('workbuddy', { token: '' });
    assert.strictEqual(store.get('workbuddy').hasToken, false);
    assert.strictEqual(store.get('workbuddy').verifiedAt, 0, '清除 Token 必须清除验证');
    expectCode('TOKEN_REQUIRED', () => store.getStartConfig('workbuddy'));

    store.updateTarget('workbuddy', { mode: 'quick' });
    store.updateTarget('workbuddy', { token: TOKEN_A });
    store.markTokenVerified('workbuddy', {
      token: TOKEN_A, tunnelId: 'tunnel-a', expectedUpdatedAt: store.get('workbuddy').updatedAt,
    });
    expectCode('PUBLIC_URL_REQUIRED', () => {
      store.updateTarget('workbuddy', { mode: 'named', publicUrl: '' });
      store.getStartConfig('workbuddy');
    });
    expectCode('TOKEN_CHANGED', () => store.markTokenVerified('workbuddy', {
      token: TOKEN_B, tunnelId: 'tunnel-b', expectedUpdatedAt: 0,
    }));
    assert.strictEqual(store.getToken('workbuddy'), TOKEN_A, '过期验证不得覆盖当前 Token');

    const passwordRecord = { algorithm: 'scrypt', salt: 'salt', hash: 'hash' };
    store.setManagerPassword(passwordRecord);
    assert.deepStrictEqual(store.getManagerPassword(), passwordRecord);
    assert.strictEqual(store.get('manager').passwordConfigured, true);
    assert.ok(!JSON.stringify(store.get('manager')).includes('hash'), '密码哈希不得进入快照');

    const reloaded = new TunnelStore(root);
    assert.strictEqual(reloaded.get('workbuddy').autoStart, false);
    assert.strictEqual(reloaded.get('workbuddy').verifiedAt > 0, true);
    assert.strictEqual(reloaded.get('workbuddy').tunnelId, 'tunnel-a');
    assert.strictEqual(reloaded.get('manager').passwordConfigured, true);

    const beforePrivate = fs.readFileSync(store.privatePath, 'utf8');
    const beforePublic = fs.readFileSync(store.publicPath, 'utf8');
    const failing = new TunnelStore(root, {
      writeAtomic(file, value, options) {
        if (file === store.publicPath) throw new Error('injected write failure');
        const { writeAtomic } = require('../src/tunnel/tunnel-store');
        return writeAtomic(file, value, options);
      },
    });
    expectCode('CONFIG_WRITE_FAILED', () => failing.updateTarget('workbuddy', { token: NEW_TOKEN, autoStart: true }));
    assert.strictEqual(fs.readFileSync(store.publicPath, 'utf8'), beforePublic, '公共文件写失败应保持原内容');
    assert.strictEqual(fs.readFileSync(store.privatePath, 'utf8'), beforePrivate, '私有文件应回滚');

    fs.writeFileSync(store.privatePath, '{broken');
    const corruptPrivate = fs.readFileSync(store.privatePath, 'utf8');
    expectCode('CONFIG_CORRUPT', () => new TunnelStore(root));
    assert.strictEqual(fs.readFileSync(store.privatePath, 'utf8'), corruptPrivate, '损坏秘密文件不得被覆盖');
    fs.writeFileSync(store.privatePath, beforePrivate);

    fs.writeFileSync(store.publicPath, '{broken');
    const corruptPublic = fs.readFileSync(store.publicPath, 'utf8');
    expectCode('CONFIG_CORRUPT', () => new TunnelStore(root));
    assert.strictEqual(fs.readFileSync(store.publicPath, 'utf8'), corruptPublic, '损坏公共文件不得被覆盖');

    console.log('PASS 隧道存储：Token 解析、验证状态、修改失效、原子写回滚、损坏 fail closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
