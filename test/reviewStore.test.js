import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReviewStore, largestRemainder, normalizeNumberText } from '../src/reviewStore.js';

function row(overrides) {
  return {
    课程号: '0083A001', 课程名称: '高等数学', 课程类别: '', 课程性质: '公共基础课',
    开课学院: '理学院', 教学班ID: 'S1', 课程学分: '4.0', 上课教师工号: '1001.0',
    上课教师姓名: '张三', 教师职称: '教授', ...overrides
  };
}

const rows = [
  row({}),
  row({ 教学班ID: 'S2', 上课教师工号: '1002', 上课教师姓名: '李四', 教师职称: '讲师;1003' }),
  row({ 课程号: 'GBK001', 课程名称: '体育(1)', 课程性质: '', 开课学院: '体育学院', 教学班ID: 'S3',
    上课教师工号: '1003', 上课教师姓名: '王五', 教师职称: '副教授' }),
  row({ 课程号: 'GBK002', 课程名称: '体育(1)', 课程性质: '', 开课学院: '体育学院', 教学班ID: 'S4',
    上课教师工号: '1004', 上课教师姓名: '王五', 教师职称: '讲师' }),
  row({ 课程号: 'TS01', 课程名称: '艺术鉴赏', 课程类别: '人文类通选课', 课程性质: '通识课,任选',
    开课学院: '文学院', 教学班ID: 'S5', 上课教师工号: '1005', 上课教师姓名: '赵六', 教师职称: '讲师;9999' }),
  row({ 教学班ID: 'S6', 上课教师姓名: '' })
];

function unitOf(store, courseId, teacherName) {
  return store.course(courseId).units.find((unit) => unit.teacher.name === teacherName);
}

test('catalog import normalizes ids, adds co-teachers and keeps same-name courses apart', () => {
  const store = new ReviewStore({ filename: ':memory:' });
  try {
    const report = store.importCatalog(rows, '2026-2027-1');
    assert.equal(report.skipped, 1);
    assert.equal(report.courses, 4);
    assert.equal(report.coUnits, 1);
    assert.deepEqual(report.unresolvedCoTeachers, ['9999']);
    assert.equal(normalizeNumberText('00853001.0'), '00853001');
    const math = store.course('0083A001');
    assert.equal(math.credits, '4');
    assert.deepEqual(math.units.map((unit) => [unit.teacher.name, unit.role]).sort(),
      [['张三', 'lead'], ['李四', 'lead'], ['王五', 'co']]);
    assert.equal(store.search('体育(1)').courses.length, 2);
    assert.equal(store.search('王五').teachers.length, 2);
    assert.ok(store.search('王五').teachers.every((teacher) => teacher.duplicateName));
    assert.deepEqual(store.search('高等数学 李四').units.map((unit) => unit.teacher.name), ['李四']);
    assert.deepEqual(store.search('50%').courses, []);

    const before = unitOf(store, '0083A001', '张三');
    store.saveReview('a', before.id, { overall: 5 });
    store.importCatalog(rows, '2027-2028-1');
    const after = unitOf(store, '0083A001', '张三');
    assert.equal(after.id, before.id);
    assert.equal(after.reviewCount, 1);
  } finally {
    store.close();
  }
});

test('lookup prefers teaching class ids and falls back to names', () => {
  const store = new ReviewStore({ filename: ':memory:' });
  try {
    store.importCatalog(rows, '2026-2027-1');
    const [exact, combined, byCode, ambiguous, missing] = store.lookup([
      { teachingClassId: 'S1' },
      { teachingClassId: 'S2' },
      { courseCode: 'TS01', teacherName: '赵六' },
      { courseName: '体育(1)', teacherName: '王五' },
      { courseName: '不存在的课' }
    ]);
    assert.equal(exact.status, 'unit');
    assert.equal(exact.unit.teacher.name, '张三');
    assert.equal(combined.status, 'course');
    assert.deepEqual(combined.units.map((unit) => unit.teacher.name), ['李四', '王五']);
    assert.equal(byCode.unit.course.name, '艺术鉴赏');
    assert.deepEqual(ambiguous, { status: 'search', query: '体育(1) 王五' });
    assert.equal(missing.status, 'none');
  } finally {
    store.close();
  }
});

test('reviews validate answers, update summaries and produce highlighted stats', () => {
  const store = new ReviewStore({ filename: ':memory:' });
  try {
    store.importCatalog(rows, '2026-2027-1');
    const unit = unitOf(store, '0083A001', '张三');
    assert.throws(() => store.saveReview('a', unit.id, { overall: 6 }), /总体评价/);
    assert.throws(() => store.saveReview('a', unit.id, { overall: 3, answers: { workload: ['none', 'heavy'] } }), /只能选一项/);
    assert.throws(() => store.saveReview('a', unit.id, { overall: 3, answers: { nope: 'x' } }), /题目无效/);
    assert.deepEqual(store.saveReview('a', 'missing', { overall: 3 }), { error: 'not_found' });

    assert.equal(store.saveReview('a', unit.id, { overall: 5, answers: {
      attendance_method: ['qr', 'quiz'], workload: 'none' } }).created, true);
    store.saveReview('b', unit.id, { overall: 3, answers: { attendance_method: ['qr'], workload: 'heavy' } });
    store.saveReview('c', unit.id, { overall: 4 });
    assert.equal(store.saveReview('c', unit.id, { overall: 1 }).created, false);

    const detail = store.unit(unit.id);
    assert.equal(detail.reviewCount, 3);
    assert.equal(detail.average, 8);
    const stat = Object.fromEntries(detail.stats.map((item) => [item.key, item]));
    assert.equal(stat.overall.answered, 3);
    assert.deepEqual(stat.overall.options.map((option) => option.percent), [34, 0, 33, 0, 33]);
    assert.equal(stat.attendance_method.answered, 2);
    assert.deepEqual(stat.attendance_method.options.filter((o) => o.count).map((o) => [o.key, o.percent, o.top]),
      [['qr', 100, true], ['quiz', 50, false]]);
    assert.deepEqual(stat.workload.options.filter((o) => o.top).map((o) => o.key), ['none', 'heavy']);
    assert.equal(stat.grading.answered, 0);
    assert.ok(stat.grading.options.every((option) => !option.top));

    assert.deepEqual(store.myReview('a', unit.id).answers, { attendance_method: ['qr', 'quiz'], workload: ['none'] });
    assert.equal(store.myReviews('a')[0].unit.id, unit.id);
    assert.equal(store.home().recent[0].id, unit.id);

    assert.equal(store.deleteMyReview('c', unit.id), true);
    assert.equal(store.unit(unit.id).average, 9);
    store.setBlocked('b', true);
    assert.deepEqual(store.saveReview('b', unit.id, { overall: 2 }), { error: 'blocked' });
    assert.equal(store.purgeAccountReviews('b'), 1);
    assert.equal(store.unit(unit.id).reviewCount, 1);
    store.deleteAccount('a');
    assert.equal(store.unit(unit.id).reviewCount, 0);
    assert.equal(store.unit(unit.id).lastReviewedAt, null);
  } finally {
    store.close();
  }
});

test('assignment assessment question keeps its key and adds exams before other', () => {
  const store = new ReviewStore({ filename: ':memory:' });
  try {
    const question = store.questions()[3];
    assert.equal(question.key, 'assignment_type');
    assert.equal(question.title, '作业/考核类型');
    assert.equal(question.multiple, true);
    assert.equal(question.required, false);
    assert.deepEqual(question.options.map((option) => [option.key, option.label]), [
      ['problems', '题目'], ['presentation', 'pre'], ['paper', '论文'],
      ['group', '小组作业'], ['exam', '考试'], ['other', '其他']
    ]);
  } finally {
    store.close();
  }
});

test('exam answers preserve stored assignment choices and update multi-select statistics', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-assessment-'));
  const filename = path.join(directory, 'reviews.sqlite');
  let store = new ReviewStore({ filename });
  try {
    store.importCatalog(rows, '2026-2027-1');
    const unit = unitOf(store, '0083A001', '张三');
    const previous = { assignment_type: ['group', 'other'] };
    store.saveReview('existing', unit.id, { overall: 4, answers: previous });
    store.close();
    store = new ReviewStore({ filename });

    const assignmentStat = () => store.unit(unit.id).stats.find((stat) => stat.key === 'assignment_type');
    assert.deepEqual(store.myReview('existing', unit.id).answers, previous);
    assert.equal(assignmentStat().options.find((option) => option.key === 'exam')?.count, 0);
    assert.throws(() => store.saveReview('invalid', unit.id, {
      overall: 5, answers: { assignment_type: ['unknown'] }
    }), /选项无效/);

    store.saveReview('new', unit.id, { overall: 5, answers: { assignment_type: ['group', 'exam'] } });
    assert.deepEqual(store.myReview('new', unit.id).answers.assignment_type, ['group', 'exam']);
    assert.deepEqual(store.myReview('existing', unit.id).answers, previous);
    assert.equal(assignmentStat().answered, 2);
    assert.deepEqual(assignmentStat().options.filter((option) => option.count)
      .map((option) => [option.key, option.count, option.percent]), [
      ['group', 2, 100], ['exam', 1, 50], ['other', 1, 50]
    ]);

    store.saveReview('existing', unit.id, {
      overall: 4, answers: { assignment_type: ['group', 'exam', 'other'] }
    });
    assert.deepEqual(store.myReview('existing', unit.id).answers.assignment_type, ['group', 'exam', 'other']);
    assert.equal(assignmentStat().options.find((option) => option.key === 'exam').percent, 100);
    assert.equal(store.deleteMyReview('new', unit.id), true);
    assert.equal(assignmentStat().answered, 1);
    assert.equal(assignmentStat().options.find((option) => option.key === 'exam').count, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rankings use the bayesian order but expose real averages', () => {
  const store = new ReviewStore({ filename: ':memory:' });
  try {
    store.importCatalog(rows, '2026-2027-1');
    const lucky = unitOf(store, '0083A001', '张三');
    const steady = unitOf(store, '0083A001', '李四');
    const weak = unitOf(store, '0083A001', '王五');
    store.saveReview('a', lucky.id, { overall: 5 });
    for (const account of ['b', 'c', 'd', 'e', 'f', 'g']) store.saveReview(account, steady.id, { overall: 5 });
    store.saveReview('h', steady.id, { overall: 4 });
    for (const account of ['i', 'j', 'k']) store.saveReview(account, weak.id, { overall: 1 });
    const ranking = store.ranking('public');
    // Prior mean 42/11: one perfect review ranks below many near-perfect ones.
    assert.deepEqual(ranking.items.map((unit) => unit.id), [steady.id, lucky.id, weak.id]);
    assert.equal(ranking.items[1].average, 10);
    assert.equal(store.ranking('general', { sub: '人文类通选课' }).total, 0);
    assert.equal(store.ranking('general', { sub: '不存在' }), null);
    assert.equal(store.ranking('nope'), null);
    assert.deepEqual(store.collegeCourses('体育学院').map((course) => course.id), ['GBK001', 'GBK002']);
  } finally {
    store.close();
  }
});

test('course review feedback is rate limited, replied and closed', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shuyo-reviews-'));
  const store = new ReviewStore({ filename: path.join(dir, 'reviews.sqlite') });
  try {
    assert.equal(statSync(path.join(dir, 'reviews.sqlite')).mode & 0o777, 0o600);
    store.importCatalog(rows, '2026-2027-1');
    const at = new Date('2026-10-08T09:00:00Z');
    const input = { kind: 'incorrect', courseId: 'TS01', content: '学分不对', appVersion: '1.0', platform: 'ios' };
    assert.throws(() => store.createFeedback('a', { ...input, kind: 'x' }), /反馈类型/);
    assert.deepEqual(store.createFeedback('a', { ...input, courseId: 'none' }, at), { error: 'invalid_target' });
    const created = store.createFeedback('a', input, at);
    for (let i = 0; i < 4; i++) store.createFeedback('a', input, at);
    assert.deepEqual(store.createFeedback('a', input, at), { error: 'rate_limited' });
    assert.ok(store.createFeedback('a', input, new Date(at.getTime() + 11 * 60 * 1000)).id);
    assert.equal(store.getFeedback(created.id, 'b'), null);
    assert.equal(store.replyFeedback(created.id, { author: 'owner', authorId: '1', message: '已修正', status: 'replied' }), true);
    const feedback = store.getFeedback(created.id, 'a');
    assert.equal(feedback.status, 'replied');
    assert.equal(feedback.course.name, '艺术鉴赏');
    assert.equal(feedback.replies[0].message, '已修正');
    assert.equal(store.closeFeedback(created.id, 'b'), 0);
    assert.equal(store.closeFeedback(created.id, 'a'), 1);
    store.deleteAccount('a');
    assert.equal(store.listFeedback().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('largest remainder percentages always sum to one hundred', () => {
  assert.deepEqual(largestRemainder([1, 1, 1], 3), [34, 33, 33]);
  assert.deepEqual(largestRemainder([0, 0], 0), [0, 0]);
  assert.equal(largestRemainder([7, 3, 5, 2], 17).reduce((a, b) => a + b, 0), 100);
});
