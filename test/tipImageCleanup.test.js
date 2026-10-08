import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanupUnusedTipImages, graceMs } from '../src/tipImageCleanup.js';

test('retains referenced or recent images and removes old unused files', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-tip-images-'));
  const now = Date.parse('2026-10-08T12:00:00Z');
  const names = {
    public: '00000000-0000-4000-8000-000000000001.png',
    draft: '00000000-0000-4000-8000-000000000002.jpg',
    unused: '00000000-0000-4000-8000-000000000003.webp',
    recent: '00000000-0000-4000-8000-000000000004.png',
  };
  try {
    for (const name of Object.values(names)) {
      const filename = path.join(directory, name);
      writeFileSync(filename, 'test');
      utimesSync(filename, new Date(now - graceMs - 1000),
        new Date(now - graceMs - 1000));
    }
    utimesSync(path.join(directory, names.recent), new Date(now), new Date(now));
    const tips = [
      { active: true, content: `![图](/api/v1/tips/images/${names.public})` },
      { active: false, content: `![图](/api/v1/tips/images/${names.draft})` },
    ];
    assert.equal(await cleanupUnusedTipImages({ directory, tips, now }), 1);
    assert.equal(existsSync(path.join(directory, names.unused)), false);
    assert.equal(existsSync(path.join(directory, names.public)), true);
    assert.equal(existsSync(path.join(directory, names.draft)), true);
    assert.equal(existsSync(path.join(directory, names.recent)), true);

    tips[1].deletedAt = new Date(now).toISOString();
    assert.equal(await cleanupUnusedTipImages({ directory, tips, now }), 1);
    assert.equal(existsSync(path.join(directory, names.draft)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
