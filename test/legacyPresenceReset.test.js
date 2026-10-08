import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('legacy presence reset leaves feedback and device blocks intact', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-reset-presence-'));
  try {
    writeFileSync(path.join(directory, 'db.json'), JSON.stringify({
      feedback: [{ id: 'legacy', content: 'keep me' }],
      blockedFeedbackDevices: [{ deviceId: 'old-device' }],
      presence: { spoofed: { activeDates: ['2026-10-07'] } }
    }));
    const result = spawnSync(process.execPath, ['scripts/clear-legacy-presence.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(path.join(directory, 'db.json'), 'utf8'));
    assert.deepEqual(state.presence, {});
    assert.equal(state.feedback[0].content, 'keep me');
    assert.equal(state.blockedFeedbackDevices[0].deviceId, 'old-device');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
