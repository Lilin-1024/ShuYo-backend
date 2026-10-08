import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const graceMs = 7 * 24 * 60 * 60 * 1000;
const intervalMs = 24 * 60 * 60 * 1000;
const filenamePattern = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/;
const referencePattern = /\/api\/v1\/tips\/images\/([0-9a-f-]{36}\.(?:png|jpg|webp))/g;

async function cleanupUnusedTipImages({ directory, tips, now = Date.now() }) {
  const referenced = new Set();
  for (const tip of tips) {
    if (tip.deletedAt) continue;
    for (const match of String(tip.content ?? '').matchAll(referencePattern)) {
      referenced.add(match[1]);
    }
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !filenamePattern.test(entry.name) ||
        referenced.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    try {
      const file = await stat(filename);
      if (now - file.mtimeMs < graceMs) continue;
      await unlink(filename);
      removed++;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

function startTipImageCleanup({ directory, loadTips }) {
  async function run() {
    try {
      const removed = await cleanupUnusedTipImages({
        directory,
        tips: await loadTips(),
      });
      if (removed > 0) console.log(`[tip-images] removed ${removed} unused images`);
    } catch (error) {
      console.error('[tip-images] cleanup failed', error);
    }
  }
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  return timer;
}

export { cleanupUnusedTipImages, graceMs, startTipImageCleanup };
