import { readFileSync } from 'node:fs';

import { ReviewStore } from '../src/reviewStore.js';
import { dataDir } from '../src/store.js';

const [file, term] = process.argv.slice(2);
if (!file || !/^\d{4}-\d{4}-[1-3]$/.test(term ?? '')) {
  process.stderr.write('用法：node scripts/import-course-catalog.js <catalog.json> <学期，如 2026-2027-1>\n');
  process.exit(2);
}

const rows = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(rows) || !rows.length || !('课程号' in rows[0])) {
  process.stderr.write('文件不是 xls-to-json.py 生成的课程一览。\n');
  process.exit(1);
}

const store = new ReviewStore({ filename: dataDir + '/reviews.sqlite' });
try {
  const report = store.importCatalog(rows, term);
  const { unresolvedCoTeachers, ...counts } = report;
  process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  process.stdout.write(`未能确定姓名的合班第二教师工号：${unresolvedCoTeachers.length} 个\n`);
} finally {
  store.close();
}
