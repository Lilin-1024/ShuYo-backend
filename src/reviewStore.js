import crypto from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Question and option keys are stored with each answer; never rename a key.
// Titles and labels may change without touching existing answers.
const QUESTIONS = [
  { key: 'overall', title: '总体评价', multiple: false, required: true, options: [
    ['1', '不推荐'], ['2', '谨慎选择'], ['3', '中规中矩'], ['4', '值得一选'], ['5', '强烈推荐']] },
  { key: 'attendance_freq', title: '签到频率', multiple: false, options: [
    ['every_class', '每节课'], ['often', '经常'], ['sometimes', '偶尔'], ['never', '从不']] },
  { key: 'attendance_method', title: '签到方式', multiple: true, options: [
    ['qr', '扫码签到'], ['location', '位置签到'], ['other_xxt', '其他学习通签到方式'],
    ['roster', '座位表/签名册'], ['quiz', '小测'], ['other', '其他']] },
  { key: 'assignment_type', title: '作业/考核类型', multiple: true, options: [
    ['problems', '题目'], ['presentation', 'pre'], ['paper', '论文'], ['group', '小组作业'], ['exam', '考试'], ['other', '其他']] },
  { key: 'discipline', title: '纪律要求', multiple: false, options: [
    ['relaxed', '比较宽松'], ['normal', '正常要求'], ['strict', '极其严格']] },
  { key: 'interaction', title: '互动情况', multiple: false, options: [
    ['lecture', '讲授为主'], ['light', '简单互动'], ['frequent', '经常提问']] },
  { key: 'workload', title: '作业量', multiple: false, options: [
    ['none', '几乎没有'], ['occasional', '偶尔有'], ['regular', '规律适中'], ['heavy', '极其繁重']] },
  { key: 'gain', title: '课堂收获', multiple: false, options: [
    ['rich', '干货满满'], ['average', '中规中矩'], ['self_study', '倾向自学']] },
  { key: 'grading', title: '给分倾向', multiple: false, options: [
    ['generous', '慷慨大方'], ['normal', '正常给分'], ['strict', '给分较严'], ['random', '玄学给分']] }
].map((question) => ({
  ...question,
  required: Boolean(question.required),
  options: question.options.map(([key, label]) => ({ key, label }))
}));

const CATEGORIES = [
  { key: 'general', title: '通识课', nature: '通识课', subcategories: [
    '人文类通选课', '理工类通选课', '经管类通选课', '人文类核心通识课', '理工类核心通识课', '经管类核心通识课'] },
  { key: 'pe', title: '体育', college: '体育学院' },
  { key: 'public', title: '公共基础课', nature: '公共基础课' },
  { key: 'seminar', title: '新生研讨课', nature: '新生研讨课', category: '新生研讨课' }
];

const FEEDBACK_KINDS = [
  { key: 'missing', label: '找不到课程或教师' },
  { key: 'incorrect', label: '课程或教师信息有误' },
  { key: 'suggestion', label: '功能建议' },
  { key: 'other', label: '其他' }
];

// Ranking only: a unit's displayed score is always its real mean.
const RANKING_PRIOR_WEIGHT = 5;
const MAX_FEEDBACK_PER_WINDOW = 5;
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;

function normalizeNumberText(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  // Excel stores some course codes, staff numbers and credits as floats.
  const match = /^(\d+)\.0+$/.exec(text);
  if (match) return match[1];
  if (/^\d+\.\d+$/.test(text)) return String(Number(text));
  return text;
}

function cleanText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function meaningful(value) {
  const text = cleanText(value);
  return text && text !== '无' && text !== '--' ? text : '';
}

function teacherNames(value) {
  return cleanText(value).split(/[,，、;；/]+/).map((item) => item.trim()).filter(Boolean);
}

function likePattern(token) {
  return `%${token.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function searchTokens(query) {
  return String(query ?? '').normalize('NFKC').split(/[\s、，,/+＋]+/)
    .map((item) => item.trim().slice(0, 40)).filter(Boolean).slice(0, 5);
}

function averageScore(sum, count) {
  return count ? Math.round((sum / count + 5) * 10) / 10 : null;
}

function largestRemainder(counts, total) {
  if (!total) return counts.map(() => 0);
  const raw = counts.map((count) => count * 100 / total);
  const result = raw.map(Math.floor);
  let left = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => [value - result[index], index])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, index] of order) {
    if (left <= 0) break;
    result[index] += 1;
    left -= 1;
  }
  return result;
}

// Builds catalog records from rows keyed by the course list's column titles.
function normalizeCatalogRows(rows) {
  const courses = new Map();
  const teachers = new Map();
  const sections = new Map();
  const units = new Map();
  const coTeachers = [];
  let skipped = 0;
  for (const row of rows) {
    const courseId = normalizeNumberText(row['课程号']);
    const teacherId = normalizeNumberText(row['上课教师工号']);
    const teacherName = cleanText(row['上课教师姓名']);
    const courseName = cleanText(row['课程名称']);
    if (!courseId || !courseName || !teacherId || !teacherName) {
      skipped += 1;
      continue;
    }
    const college = cleanText(row['开课学院']);
    const [title, ...extra] = cleanText(row['教师职称']).split(/[;；]/);
    const course = courses.get(courseId) ?? {
      id: courseId, name: courseName, college, credits: normalizeNumberText(row['课程学分']),
      natures: new Set(), category: ''
    };
    for (const nature of cleanText(row['课程性质']).split(/[,，]/)) {
      if (meaningful(nature)) course.natures.add(meaningful(nature));
    }
    course.category ||= meaningful(row['课程类别']);
    courses.set(courseId, course);
    if (!teachers.has(teacherId)) {
      teachers.set(teacherId, { id: teacherId, name: teacherName, college, title: meaningful(title) });
    }
    units.set(`${courseId}\u0000${teacherId}`, { courseId, teacherId, role: 'lead' });
    // The title column carries a second teacher's staff number on combined classes.
    const co = extra.map(normalizeNumberText).filter((item) => /^\d+$/.test(item) && item !== teacherId);
    for (const id of co) coTeachers.push({ courseId, teacherId: id });
    const sectionId = cleanText(row['教学班ID']);
    if (sectionId) sections.set(sectionId, { id: sectionId, courseId, teacherIds: [teacherId, ...co] });
  }
  const unresolved = new Set();
  for (const { courseId, teacherId } of coTeachers) {
    if (!teachers.has(teacherId)) {
      unresolved.add(teacherId);
      continue;
    }
    const key = `${courseId}\u0000${teacherId}`;
    if (!units.has(key)) units.set(key, { courseId, teacherId, role: 'co' });
  }
  for (const section of sections.values()) {
    section.teacherIds = section.teacherIds.filter((id) => teachers.has(id));
  }
  return {
    courses: [...courses.values()].map((course) => ({ ...course, natures: [...course.natures] })),
    teachers: [...teachers.values()],
    units: [...units.values()],
    sections: [...sections.values()],
    skipped,
    unresolvedCoTeachers: [...unresolved].sort()
  };
}

function publicId(prefix) {
  return `${prefix}${crypto.randomBytes(9).toString('base64url')}`;
}

const UNIT_SELECT = `
  SELECT u.id AS unit_id, u.role, u.review_count, u.overall_sum, u.last_reviewed_at, u.last_term,
    c.id AS course_id, c.name AS course_name, c.college AS course_college, c.credits AS course_credits,
    t.public_id AS teacher_id, t.name AS teacher_name, t.college AS teacher_college, t.title AS teacher_title,
    (SELECT COUNT(*) FROM teachers t2 WHERE t2.name = t.name) > 1 AS duplicate_name
  FROM units u JOIN courses c ON c.id = u.course_id JOIN teachers t ON t.id = u.teacher_id`;

function unitSummary(row) {
  if (!row) return null;
  return {
    id: row.unit_id,
    role: row.role,
    reviewCount: row.review_count,
    average: averageScore(row.overall_sum, row.review_count),
    lastReviewedAt: row.last_reviewed_at ?? null,
    course: { id: row.course_id, name: row.course_name, college: row.course_college, credits: row.course_credits },
    teacher: {
      id: row.teacher_id, name: row.teacher_name, college: row.teacher_college,
      title: row.teacher_title, duplicateName: Boolean(row.duplicate_name)
    }
  };
}

class ReviewStore {
  constructor({ filename }) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 1) throw new Error(`Unsupported review database version: ${version}`);
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE courses (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, college TEXT NOT NULL, credits TEXT NOT NULL,
        natures TEXT NOT NULL, category TEXT NOT NULL, last_term TEXT NOT NULL
      ) STRICT;
      CREATE INDEX courses_name_idx ON courses(name);
      CREATE INDEX courses_college_idx ON courses(college);
      CREATE TABLE teachers (
        id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        college TEXT NOT NULL, title TEXT NOT NULL
      ) STRICT;
      CREATE INDEX teachers_name_idx ON teachers(name);
      CREATE TABLE units (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
        teacher_id TEXT NOT NULL REFERENCES teachers(id),
        role TEXT NOT NULL CHECK(role IN ('lead','co')), last_term TEXT NOT NULL,
        review_count INTEGER NOT NULL DEFAULT 0, overall_sum INTEGER NOT NULL DEFAULT 0,
        last_reviewed_at TEXT, UNIQUE(course_id, teacher_id)
      ) STRICT;
      CREATE INDEX units_teacher_idx ON units(teacher_id);
      CREATE INDEX units_recent_idx ON units(last_reviewed_at);
      CREATE TABLE sections (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
        teacher_ids TEXT NOT NULL, term TEXT NOT NULL
      ) STRICT;
      CREATE TABLE catalog_imports (
        term TEXT PRIMARY KEY, imported_at TEXT NOT NULL, report TEXT NOT NULL
      ) STRICT;
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id), account_id TEXT NOT NULL,
        overall INTEGER NOT NULL CHECK(overall BETWEEN 1 AND 5),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(unit_id, account_id)
      ) STRICT;
      CREATE INDEX reviews_account_idx ON reviews(account_id, updated_at DESC);
      CREATE INDEX reviews_updated_idx ON reviews(updated_at DESC);
      CREATE TABLE review_answers (
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        question TEXT NOT NULL, option TEXT NOT NULL, PRIMARY KEY(review_id, question, option)
      ) STRICT;
      CREATE TABLE review_blocks (account_id TEXT PRIMARY KEY, blocked_at TEXT NOT NULL) STRICT;
      CREATE TABLE rate_feedback (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('missing','incorrect','suggestion','other')),
        unit_id TEXT, course_id TEXT, content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','replied','closed')),
        app_version TEXT NOT NULL, platform TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX rate_feedback_account_idx ON rate_feedback(account_id, created_at DESC);
      CREATE TABLE rate_feedback_replies (
        id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES rate_feedback(id) ON DELETE CASCADE,
        author TEXT NOT NULL, author_id TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Catalog

  importCatalog(rows, term, now = new Date()) {
    const label = cleanText(term);
    if (!label || label.length > 32) throw new Error('学期标识无效。');
    const catalog = normalizeCatalogRows(rows);
    const report = {
      term: label, rows: rows.length, skipped: catalog.skipped, courses: catalog.courses.length,
      teachers: catalog.teachers.length, sections: catalog.sections.length,
      leadUnits: catalog.units.filter((unit) => unit.role === 'lead').length,
      coUnits: catalog.units.filter((unit) => unit.role === 'co').length,
      unresolvedCoTeachers: catalog.unresolvedCoTeachers
    };
    this.transaction(() => {
      const course = this.db.prepare(`INSERT INTO courses(id, name, college, credits, natures, category, last_term)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
        college = excluded.college, credits = excluded.credits, natures = excluded.natures,
        category = excluded.category, last_term = excluded.last_term`);
      for (const item of catalog.courses) {
        course.run(item.id, item.name, item.college, item.credits, JSON.stringify(item.natures), item.category, label);
      }
      const teacher = this.db.prepare(`INSERT INTO teachers(id, public_id, name, college, title)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
        college = excluded.college, title = excluded.title`);
      for (const item of catalog.teachers) teacher.run(item.id, publicId('t_'), item.name, item.college, item.title);
      const unit = this.db.prepare(`INSERT INTO units(id, course_id, teacher_id, role, last_term)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(course_id, teacher_id) DO UPDATE SET last_term = excluded.last_term,
        role = CASE WHEN units.role = 'lead' OR excluded.role = 'lead' THEN 'lead' ELSE 'co' END`);
      for (const item of catalog.units) unit.run(publicId('u_'), item.courseId, item.teacherId, item.role, label);
      const section = this.db.prepare(`INSERT INTO sections(id, course_id, teacher_ids, term) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id, teacher_ids = excluded.teacher_ids,
        term = excluded.term`);
      for (const item of catalog.sections) section.run(item.id, item.courseId, JSON.stringify(item.teacherIds), label);
      this.db.prepare(`INSERT INTO catalog_imports(term, imported_at, report) VALUES (?, ?, ?)
        ON CONFLICT(term) DO UPDATE SET imported_at = excluded.imported_at, report = excluded.report`)
        .run(label, now.toISOString(), JSON.stringify(report));
    });
    return report;
  }

  catalogImports() {
    return this.db.prepare('SELECT term, imported_at AS importedAt, report FROM catalog_imports ORDER BY imported_at DESC')
      .all().map((row) => ({ ...row, report: JSON.parse(row.report) }));
  }

  questions() {
    return QUESTIONS;
  }

  categories() {
    return CATEGORIES.map(({ key, title, subcategories }) => ({ key, title, subcategories: subcategories ?? [] }));
  }

  feedbackKinds() {
    return FEEDBACK_KINDS;
  }

  // Public reads

  unitRows(where, params = [], order = 'c.name, t.name', limit = 200, offset = 0) {
    return this.db.prepare(`${UNIT_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(unitSummary);
  }

  courseSummary(row) {
    return {
      id: row.id, name: row.name, college: row.college, credits: row.credits,
      teacherCount: row.teacher_count, reviewCount: row.review_count ?? 0,
      average: averageScore(row.overall_sum ?? 0, row.review_count ?? 0)
    };
  }

  courseRows(where, params, order, limit) {
    return this.db.prepare(`SELECT c.id, c.name, c.college, c.credits,
        COUNT(u.id) AS teacher_count, SUM(u.review_count) AS review_count, SUM(u.overall_sum) AS overall_sum
      FROM courses c LEFT JOIN units u ON u.course_id = c.id
      WHERE ${where} GROUP BY c.id ORDER BY ${order} LIMIT ?`)
      .all(...params, limit).map((row) => this.courseSummary(row));
  }

  search(query) {
    const tokens = searchTokens(query);
    if (!tokens.length) return { units: [], courses: [], teachers: [] };
    const patterns = tokens.map(likePattern);
    const exact = String(query ?? '').normalize('NFKC').trim().toUpperCase();
    const courseMatch = (pattern) => [`(c.name LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\')`, [pattern, pattern]];
    let units = [];
    if (tokens.length > 1) {
      const all = patterns.map((pattern) =>
        [`(c.name LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')`, [pattern, pattern, pattern]]);
      const anyTeacher = `(${patterns.map(() => `t.name LIKE ? ESCAPE '\\'`).join(' OR ')})`;
      const anyCourse = `(${patterns.map(() => `c.name LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\'`).join(' OR ')})`;
      units = this.unitRows(
        [...all.map(([sql]) => sql), anyTeacher, anyCourse].join(' AND '),
        [...all.flatMap(([, params]) => params), ...patterns, ...patterns.flatMap((p) => [p, p])],
        'u.review_count DESC, c.name, t.name', 50);
    }
    const courseParts = patterns.map(courseMatch);
    const courses = this.courseRows(courseParts.map(([sql]) => sql).join(' AND '),
      [...courseParts.flatMap(([, params]) => params), exact],
      'UPPER(c.id) = ? DESC, LENGTH(c.name), c.name, c.id', 50);
    const teachers = this.db.prepare(`SELECT t.public_id AS id, t.name, t.college, t.title,
        COUNT(u.id) AS course_count, SUM(u.review_count) AS review_count, SUM(u.overall_sum) AS overall_sum,
        (SELECT COUNT(*) FROM teachers t2 WHERE t2.name = t.name) > 1 AS duplicate_name
      FROM teachers t JOIN units u ON u.teacher_id = t.id
      WHERE ${patterns.map(() => `t.name LIKE ? ESCAPE '\\'`).join(' AND ')}
      GROUP BY t.id ORDER BY LENGTH(t.name), t.name LIMIT 30`)
      .all(...patterns).map((row) => ({
        id: row.id, name: row.name, college: row.college, title: row.title,
        duplicateName: Boolean(row.duplicate_name), courseCount: row.course_count,
        reviewCount: row.review_count ?? 0, average: averageScore(row.overall_sum ?? 0, row.review_count ?? 0)
      }));
    return { units, courses, teachers };
  }

  course(courseId) {
    const row = this.db.prepare('SELECT * FROM courses WHERE id = ?').get(String(courseId ?? ''));
    if (!row) return null;
    return {
      id: row.id, name: row.name, college: row.college, credits: row.credits,
      natures: JSON.parse(row.natures), category: row.category, lastTerm: row.last_term,
      units: this.unitRows('u.course_id = ?', [row.id],
        `u.review_count > 0 DESC, (u.overall_sum * 1.0 / MAX(u.review_count, 1)) DESC, u.review_count DESC,
         u.role = 'lead' DESC, t.name`)
    };
  }

  teacher(teacherPublicId) {
    const row = this.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM teachers t2 WHERE t2.name = t.name) > 1 AS duplicate_name
      FROM teachers t WHERE public_id = ?`).get(String(teacherPublicId ?? ''));
    if (!row) return null;
    return {
      id: row.public_id, name: row.name, college: row.college, title: row.title,
      duplicateName: Boolean(row.duplicate_name),
      units: this.unitRows('u.teacher_id = ?', [row.id], 'u.review_count DESC, c.name, c.id')
    };
  }

  unit(unitId) {
    const summary = this.unitRows('u.id = ?', [String(unitId ?? '')], 'u.id', 1)[0];
    if (!summary) return null;
    return { ...summary, stats: this.unitStats(summary.id) };
  }

  unitStats(unitId) {
    const overall = new Map(this.db.prepare('SELECT overall, COUNT(*) AS n FROM reviews WHERE unit_id = ? GROUP BY overall')
      .all(unitId).map((row) => [String(row.overall), row.n]));
    const counts = new Map();
    for (const row of this.db.prepare(`SELECT a.question, a.option, COUNT(*) AS n FROM review_answers a
      JOIN reviews r ON r.id = a.review_id WHERE r.unit_id = ? GROUP BY a.question, a.option`).all(unitId)) {
      counts.set(`${row.question}\u0000${row.option}`, row.n);
    }
    const answered = new Map(this.db.prepare(`SELECT a.question, COUNT(DISTINCT a.review_id) AS n FROM review_answers a
      JOIN reviews r ON r.id = a.review_id WHERE r.unit_id = ? GROUP BY a.question`).all(unitId)
      .map((row) => [row.question, row.n]));
    answered.set('overall', [...overall.values()].reduce((sum, value) => sum + value, 0));
    return QUESTIONS.map((question) => {
      const total = answered.get(question.key) ?? 0;
      const optionCounts = question.options.map((option) => question.key === 'overall'
        ? overall.get(option.key) ?? 0
        : counts.get(`${question.key}\u0000${option.key}`) ?? 0);
      const percents = question.multiple
        ? optionCounts.map((count) => (total ? Math.round(count * 100 / total) : 0))
        : largestRemainder(optionCounts, total);
      const top = Math.max(0, ...optionCounts);
      return {
        key: question.key, title: question.title, multiple: question.multiple, answered: total,
        options: question.options.map((option, index) => ({
          key: option.key, label: option.label, count: optionCounts[index], percent: percents[index],
          top: top > 0 && optionCounts[index] === top
        }))
      };
    });
  }

  categoryWhere(category, sub = '') {
    const parts = [];
    const params = [];
    if (category.nature) {
      parts.push('EXISTS (SELECT 1 FROM json_each(c.natures) WHERE value = ?)');
      params.push(category.nature);
    }
    if (category.category) {
      parts.push('c.category = ?');
      params.push(category.category);
    }
    if (category.college) {
      parts.push('c.college = ?');
      params.push(category.college);
    }
    let sql = `(${parts.join(' OR ')})`;
    if (sub) {
      sql += ' AND c.category = ?';
      params.push(sub);
    }
    return { sql, params };
  }

  ranking(key, { sub = '', limit = 20, offset = 0 } = {}) {
    const category = CATEGORIES.find((item) => item.key === key);
    if (!category) return null;
    if (sub && !(category.subcategories ?? []).includes(sub)) return null;
    const base = this.categoryWhere(category);
    const prior = this.db.prepare(`SELECT SUM(u.overall_sum) AS s, SUM(u.review_count) AS n
      FROM units u JOIN courses c ON c.id = u.course_id WHERE u.review_count > 0 AND ${base.sql}`)
      .get(...base.params);
    const mean = prior.n ? prior.s / prior.n : 3;
    const filter = this.categoryWhere(category, sub);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM units u JOIN courses c ON c.id = u.course_id
      WHERE u.review_count > 0 AND ${filter.sql}`).get(...filter.params).n;
    const weight = RANKING_PRIOR_WEIGHT;
    const items = this.unitRows(`u.review_count > 0 AND ${filter.sql}`, filter.params,
      `(${weight * mean} + u.overall_sum) * 1.0 / (${weight} + u.review_count) DESC, u.review_count DESC, c.name`,
      limit, offset);
    return {
      key: category.key, title: category.title, subcategories: category.subcategories ?? [],
      sub, total, items
    };
  }

  colleges() {
    return this.db.prepare(`SELECT college AS name, COUNT(*) AS courseCount FROM courses
      WHERE college != '' GROUP BY college ORDER BY courseCount DESC, college`).all();
  }

  collegeCourses(college) {
    return this.courseRows('c.college = ?', [String(college ?? '')], 'c.name, c.id', 1000);
  }

  home(now = new Date()) {
    return {
      recent: this.unitRows('u.review_count > 0', [], 'u.last_reviewed_at DESC', 20),
      rankings: CATEGORIES.map((category) => {
        const ranking = this.ranking(category.key, { limit: 10 });
        return { key: ranking.key, title: ranking.title, total: ranking.total, items: ranking.items };
      }),
      colleges: this.colleges(),
      generatedAt: now.toISOString()
    };
  }

  // Matches schedule courses to units. Section IDs are exact; names are a fallback.
  lookup(items) {
    return items.map((item) => {
      const sectionId = cleanText(item?.teachingClassId);
      const courseCode = cleanText(item?.courseCode);
      const courseName = cleanText(item?.courseName);
      const names = teacherNames(item?.teacherName);
      const section = sectionId
        ? this.db.prepare('SELECT course_id, teacher_ids FROM sections WHERE id = ?').get(sectionId)
        : null;
      if (section) {
        const ids = JSON.parse(section.teacher_ids);
        const units = ids.length
          ? this.unitRows(`u.course_id = ? AND u.teacher_id IN (${ids.map(() => '?').join(',')})`,
            [section.course_id, ...ids], "u.role = 'lead' DESC, t.name")
          : [];
        return units.length === 1
          ? { status: 'unit', unit: units[0] }
          : { status: 'course', courseId: section.course_id, unitIds: units.map((unit) => unit.id), units };
      }
      const course = courseCode ? this.db.prepare('SELECT id FROM courses WHERE id = ?').get(courseCode) : null;
      if (course) {
        const units = this.unitRows('u.course_id = ?', [course.id], 't.name')
          .filter((unit) => names.includes(unit.teacher.name));
        return units.length === 1
          ? { status: 'unit', unit: units[0] }
          : { status: 'course', courseId: course.id, unitIds: units.map((unit) => unit.id), units };
      }
      if (!courseName) return { status: 'none', query: '' };
      const units = names.length
        ? this.unitRows(`c.name = ? AND t.name IN (${names.map(() => '?').join(',')})`, [courseName, ...names], 'c.id')
        : [];
      if (units.length === 1) return { status: 'unit', unit: units[0] };
      const named = this.db.prepare('SELECT 1 FROM courses WHERE name = ? LIMIT 1').get(courseName);
      return named
        ? { status: 'search', query: [courseName, ...names.slice(0, 1)].join(' ') }
        : { status: 'none', query: courseName };
    });
  }

  // Reviews

  isBlocked(accountId) {
    return Boolean(this.db.prepare('SELECT 1 FROM review_blocks WHERE account_id = ?').get(accountId));
  }

  setBlocked(accountId, blocked, now = new Date()) {
    if (blocked) this.db.prepare('INSERT OR IGNORE INTO review_blocks(account_id, blocked_at) VALUES (?, ?)')
      .run(accountId, now.toISOString());
    else this.db.prepare('DELETE FROM review_blocks WHERE account_id = ?').run(accountId);
  }

  listBlocks() {
    return this.db.prepare('SELECT account_id AS accountId, blocked_at AS blockedAt FROM review_blocks ORDER BY blocked_at DESC').all();
  }

  validateReview(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('评价格式无效。');
    const overall = Number(input.overall);
    if (!Number.isInteger(overall) || overall < 1 || overall > 5) throw new Error('请选择总体评价。');
    const answers = input.answers ?? {};
    if (typeof answers !== 'object' || Array.isArray(answers)) throw new Error('评价格式无效。');
    const result = [];
    for (const [key, value] of Object.entries(answers)) {
      const question = QUESTIONS.find((item) => item.key === key && item.key !== 'overall');
      if (!question) throw new Error('评价题目无效。');
      const selected = [...new Set((Array.isArray(value) ? value : [value]).filter((item) => item !== null && item !== ''))];
      if (!selected.length) continue;
      if (!question.multiple && selected.length > 1) throw new Error(`「${question.title}」只能选一项。`);
      for (const option of selected) {
        if (!question.options.some((item) => item.key === option)) throw new Error(`「${question.title}」选项无效。`);
        result.push([key, option]);
      }
    }
    return { overall, answers: result };
  }

  refreshUnits(unitIds) {
    const update = this.db.prepare(`UPDATE units SET
      review_count = (SELECT COUNT(*) FROM reviews WHERE unit_id = units.id),
      overall_sum = COALESCE((SELECT SUM(overall) FROM reviews WHERE unit_id = units.id), 0),
      last_reviewed_at = (SELECT MAX(updated_at) FROM reviews WHERE unit_id = units.id)
      WHERE id = ?`);
    for (const id of new Set(unitIds)) update.run(id);
  }

  reviewAnswers(reviewId) {
    const answers = {};
    for (const row of this.db.prepare('SELECT question, option FROM review_answers WHERE review_id = ? ORDER BY rowid')
      .all(reviewId)) {
      (answers[row.question] ??= []).push(row.option);
    }
    return answers;
  }

  myReview(accountId, unitId) {
    const row = this.db.prepare('SELECT * FROM reviews WHERE unit_id = ? AND account_id = ?').get(unitId, accountId);
    if (!row) return null;
    return {
      id: row.id, unitId: row.unit_id, overall: row.overall, answers: this.reviewAnswers(row.id),
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  myReviews(accountId) {
    const rows = this.db.prepare(`SELECT r.id AS review_id, r.overall, r.created_at, r.updated_at,
        EXISTS (SELECT 1 FROM review_answers a WHERE a.review_id = r.id AND a.question = 'grading') AS has_grading,
        u.id AS unit_id FROM reviews r JOIN units u ON u.id = r.unit_id
      WHERE r.account_id = ? ORDER BY r.updated_at DESC`).all(accountId);
    return rows.map((row) => ({
      id: row.review_id, overall: row.overall, createdAt: row.created_at, updatedAt: row.updated_at,
      hasGrading: Boolean(row.has_grading),
      unit: this.unitRows('u.id = ?', [row.unit_id], 'u.id', 1)[0]
    }));
  }

  saveReview(accountId, unitId, input, now = new Date()) {
    const { overall, answers } = this.validateReview(input);
    return this.transaction(() => {
      if (this.isBlocked(accountId)) return { error: 'blocked' };
      if (!this.db.prepare('SELECT 1 FROM units WHERE id = ?').get(unitId)) return { error: 'not_found' };
      const at = now.toISOString();
      const existing = this.db.prepare('SELECT id FROM reviews WHERE unit_id = ? AND account_id = ?').get(unitId, accountId);
      const id = existing?.id ?? `rv_${crypto.randomUUID()}`;
      if (existing) {
        this.db.prepare('UPDATE reviews SET overall = ?, updated_at = ? WHERE id = ?').run(overall, at, id);
        this.db.prepare('DELETE FROM review_answers WHERE review_id = ?').run(id);
      } else {
        this.db.prepare(`INSERT INTO reviews(id, unit_id, account_id, overall, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(id, unitId, accountId, overall, at, at);
      }
      const answer = this.db.prepare('INSERT INTO review_answers(review_id, question, option) VALUES (?, ?, ?)');
      for (const [question, option] of answers) answer.run(id, question, option);
      this.refreshUnits([unitId]);
      return { review: this.myReview(accountId, unitId), created: !existing };
    });
  }

  deleteMyReview(accountId, unitId) {
    return this.transaction(() => {
      const changes = this.db.prepare('DELETE FROM reviews WHERE unit_id = ? AND account_id = ?').run(unitId, accountId).changes;
      if (changes) this.refreshUnits([unitId]);
      return changes > 0;
    });
  }

  // Admin moderation

  adminReviews({ query = '', accountId = '', limit = 50, offset = 0 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    for (const pattern of searchTokens(query).map(likePattern)) {
      where.push(`(c.name LIKE ? ESCAPE '\\' OR c.id LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern);
    }
    if (accountId) {
      where.push('r.account_id = ?');
      params.push(accountId);
    }
    const from = `FROM reviews r JOIN units u ON u.id = r.unit_id JOIN courses c ON c.id = u.course_id
      JOIN teachers t ON t.id = u.teacher_id WHERE ${where.join(' AND ')}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
    const items = this.db.prepare(`SELECT r.id, r.account_id AS accountId, r.overall, r.created_at AS createdAt,
        r.updated_at AS updatedAt, u.id AS unitId, c.id AS courseId, c.name AS courseName, t.name AS teacherName,
        EXISTS (SELECT 1 FROM review_blocks b WHERE b.account_id = r.account_id) AS blocked
      ${from} ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)
      .map((row) => ({ ...row, blocked: Boolean(row.blocked), answers: this.reviewAnswers(row.id) }));
    return { total, items };
  }

  adminDeleteReview(reviewId) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT unit_id FROM reviews WHERE id = ?').get(reviewId);
      if (!row) return false;
      this.db.prepare('DELETE FROM reviews WHERE id = ?').run(reviewId);
      this.refreshUnits([row.unit_id]);
      return true;
    });
  }

  deleteAccountReviews(accountId) {
    const units = this.db.prepare('SELECT unit_id FROM reviews WHERE account_id = ?').all(accountId).map((row) => row.unit_id);
    const changes = this.db.prepare('DELETE FROM reviews WHERE account_id = ?').run(accountId).changes;
    this.refreshUnits(units);
    return changes;
  }

  purgeAccountReviews(accountId) {
    return this.transaction(() => this.deleteAccountReviews(accountId));
  }

  // Course review feedback, kept apart from the app feedback in engagement.sqlite.

  createFeedback(accountId, { kind, unitId, courseId, content, appVersion, platform }, now = new Date()) {
    if (!FEEDBACK_KINDS.some((item) => item.key === kind)) throw new Error('请选择反馈类型。');
    return this.transaction(() => {
      if (this.isBlocked(accountId)) return { error: 'blocked' };
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM rate_feedback WHERE account_id = ? AND created_at >= ?')
        .get(accountId, new Date(now.getTime() - FEEDBACK_WINDOW_MS).toISOString()).n;
      if (recent >= MAX_FEEDBACK_PER_WINDOW) return { error: 'rate_limited' };
      if (unitId && !this.db.prepare('SELECT 1 FROM units WHERE id = ?').get(unitId)) return { error: 'invalid_target' };
      if (courseId && !this.db.prepare('SELECT 1 FROM courses WHERE id = ?').get(courseId)) return { error: 'invalid_target' };
      const id = `rf_${crypto.randomUUID()}`;
      const at = now.toISOString();
      this.db.prepare(`INSERT INTO rate_feedback(id, account_id, kind, unit_id, course_id, content, status,
          app_version, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
        .run(id, accountId, kind, unitId || null, courseId || null, content, appVersion, platform, at, at);
      return { id, status: 'open', createdAt: at };
    });
  }

  rowToFeedback(row) {
    if (!row) return null;
    const unit = row.unit_id ? this.unitRows('u.id = ?', [row.unit_id], 'u.id', 1)[0] ?? null : null;
    const course = row.course_id
      ? this.db.prepare('SELECT id, name, college FROM courses WHERE id = ?').get(row.course_id) ?? null
      : null;
    return {
      id: row.id, accountId: row.account_id, kind: row.kind,
      kindLabel: FEEDBACK_KINDS.find((item) => item.key === row.kind)?.label ?? row.kind,
      unit, course: course ? { ...course } : null,
      content: row.content, status: row.status, appVersion: row.app_version, platform: row.platform,
      createdAt: row.created_at, updatedAt: row.updated_at, blocked: this.isBlocked(row.account_id),
      replies: this.db.prepare(`SELECT id, author, message, created_at AS createdAt
        FROM rate_feedback_replies WHERE feedback_id = ? ORDER BY created_at, rowid`).all(row.id)
    };
  }

  getFeedback(id, accountId = null) {
    const row = accountId === null
      ? this.db.prepare('SELECT * FROM rate_feedback WHERE id = ?').get(id)
      : this.db.prepare('SELECT * FROM rate_feedback WHERE id = ? AND account_id = ?').get(id, accountId);
    return this.rowToFeedback(row);
  }

  listFeedback(accountId = null, status = '') {
    const where = [];
    const params = [];
    if (accountId !== null) {
      where.push('account_id = ?');
      params.push(accountId);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    return this.db.prepare(`SELECT * FROM rate_feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC`).all(...params).map((row) => this.rowToFeedback(row));
  }

  closeFeedback(id, accountId = null, now = new Date()) {
    const sql = `UPDATE rate_feedback SET status = 'closed', updated_at = ? WHERE id = ? AND status != 'closed'`;
    return accountId === null
      ? this.db.prepare(sql).run(now.toISOString(), id).changes
      : this.db.prepare(`${sql} AND account_id = ?`).run(now.toISOString(), id, accountId).changes;
  }

  replyFeedback(id, { author, authorId, message, status }, now = new Date()) {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM rate_feedback WHERE id = ?').get(id)) return false;
      const at = now.toISOString();
      this.db.prepare(`INSERT INTO rate_feedback_replies(id, feedback_id, author, author_id, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), id, author, authorId, message, at);
      this.db.prepare('UPDATE rate_feedback SET status = ?, updated_at = ? WHERE id = ?').run(status, at, id);
      return true;
    });
  }

  deleteAccount(accountId) {
    this.transaction(() => {
      this.deleteAccountReviews(accountId);
      this.db.prepare('DELETE FROM rate_feedback WHERE account_id = ?').run(accountId);
      this.db.prepare('DELETE FROM review_blocks WHERE account_id = ?').run(accountId);
    });
  }

  close() { this.db.close(); }
}

export {
  CATEGORIES, FEEDBACK_KINDS, QUESTIONS, ReviewStore,
  largestRemainder, normalizeCatalogRows, normalizeNumberText, searchTokens
};
