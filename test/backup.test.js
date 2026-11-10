import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

test('online backup: live WAL, concurrency, restore verification and safe two-set retention', (t) => {
  const available = spawnSync('python3', ['-c', 'import sqlite3, fcntl'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT' || available.status !== 0) {
    t.skip('Online-backup tests require Python 3 with sqlite3 and Unix flock; run them on the Linux host.');
    return;
  }
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'backup_online_test.py', '-v'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
