import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { AdminStore } from '../src/adminStore.js';
import { dataDir } from '../src/store.js';

const username = process.argv[2];
if (!process.stdin.isTTY || !process.stdout.isTTY || !username) {
  process.stderr.write('用法：在交互终端运行 node scripts/admin-cli.js <总管理员登录名>\n');
  process.exit(2);
}

let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  }
});
const input = createInterface({ input: process.stdin, output, terminal: true });

async function secret(prompt) {
  process.stdout.write(prompt);
  muted = true;
  const value = await new Promise((resolve) => input.question('', resolve));
  muted = false;
  process.stdout.write('\n');
  return value;
}

try {
  const password = await secret('设置密码（至少 12 个字符）：');
  const confirmation = await secret('再次输入密码：');
  if (password !== confirmation) throw new Error('两次密码不一致。');
  const store = new AdminStore({ filename: dataDir + '/admins.sqlite' });
  try {
    store.bootstrap(username, password);
  } finally {
    store.close();
  }
  process.stdout.write('总管理员账号已建立。\n');
} catch (error) {
  process.stderr.write(String(error.message ?? error) + '\n');
  process.exitCode = 1;
} finally {
  input.close();
}
