import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-rate-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.COOKIE_SECURE = 'false';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);
process.env.SHARE_DATA_KEY = '33'.repeat(32);

const { app, studentIdentityStore, reviewStore } = await import('../src/server.js');

const catalog = [
  { 课程号: 'TS01', 课程名称: '艺术鉴赏', 课程类别: '人文类通选课', 课程性质: '通识课', 开课学院: '文学院',
    教学班ID: 'S1', 课程学分: '2', 上课教师工号: '1001', 上课教师姓名: '张三', 教师职称: '教授' },
  { 课程号: 'TS01', 课程名称: '艺术鉴赏', 课程类别: '人文类通选课', 课程性质: '通识课', 开课学院: '文学院',
    教学班ID: 'S2', 课程学分: '2', 上课教师工号: '1002', 上课教师姓名: '李四', 教师职称: '讲师;1001' }
];

test('public reads, student reviews and course review feedback', async () => {
  reviewStore.importCatalog(catalog, '2026-2027-1');
  const first = studentIdentityStore.createSession({ studentId: '12345678' });
  const other = studentIdentityStore.createSession({ studentId: '87654321' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', token, body } = {}) => fetch(base + route, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = async (response) => (await response.json()).data;
  try {
    const questionsResponse = await request('/api/v1/rate/questions');
    const questionsEtag = questionsResponse.headers.get('etag');
    const questions = await json(questionsResponse);
    assert.deepEqual(questions.questions.map((question) => question.key), [
      'overall', 'attendance_freq', 'attendance_method', 'discipline', 'interaction', 'workload',
      'assignment_type', 'difficulty', 'gain', 'grading', 'teacher_tags'
    ]);
    assert.ok(questions.questions.every((question) => typeof question.description === 'string'));
    assert.equal(questions.questions.find((question) => question.key === 'grading').description,
      '单选，可跳过（建议在出分后填写）');
    const tagsQuestion = questions.questions.find((question) => question.key === 'teacher_tags');
    assert.equal(tagsQuestion.title, '你想送给老师的标签');
    assert.equal(tagsQuestion.required, false);
    assert.equal(tagsQuestion.multiple, true);
    assert.equal(tagsQuestion.maxSelections, 3);
    assert.equal(tagsQuestion.description, '多选，最多三项（如果有的话）');
    assert.equal(tagsQuestion.preserveOnOmission, undefined);
    assert.equal((await fetch(`${base}/api/v1/rate/questions`, {
      headers: { 'if-none-match': questionsEtag }
    })).status, 304);
    assert.equal(questions.categories.length, 4);
    const assignment = questions.questions.find((item) => item.key === 'assignment_type');
    assert.equal(assignment.key, 'assignment_type');
    assert.equal(assignment.title, '作业/考核类型');
    assert.equal(assignment.multiple, true);
    assert.equal(assignment.required, false);
    assert.deepEqual(assignment.options.map((option) => [option.key, option.label]), [
      ['problems', '题目'], ['presentation', 'pre'], ['paper', '论文'],
      ['group', '小组作业'], ['exam', '考试'], ['other', '其他']
    ]);

    const [lookup] = await json(await request('/api/v1/rate/units/lookup', {
      method: 'POST', body: { items: [{ teachingClassId: 'S1' }] } }));
    assert.equal(lookup.status, 'unit');
    const unitId = lookup.unit.id;
    assert.equal((await request('/api/v1/rate/units/lookup', {
      method: 'POST', body: { items: Array(61).fill({}) } })).status, 400);

    const route = `/api/v1/student/rate/reviews/${unitId}`;
    assert.equal((await request(route, { method: 'PUT', body: { overall: 5 } })).status, 401);
    assert.equal((await request(route, { method: 'PUT', token: first.token, body: { overall: 9 } })).status, 400);
    assert.equal((await request('/api/v1/student/rate/reviews/u_missing', {
      method: 'PUT', token: first.token, body: { overall: 5 } })).status, 404);
    const created = await request(route, { method: 'PUT', token: first.token,
      body: { overall: 5, answers: {
        grading: 'generous', attendance_method: ['qr', 'quiz'], assignment_type: ['group', 'exam'],
        difficulty: 'hard', teacher_tags: ['humorous', 'clear', 'rigorous']
      } } });
    assert.equal(created.status, 201);
    assert.deepEqual((await json(created)).answers.assignment_type, ['group', 'exam']);
    assert.equal((await request(route, { method: 'PUT', token: first.token,
      body: { overall: 4, answers: { assignment_type: ['exam', 'other'] } } })).status, 200);
    const saved = await json(await request(route, { token: first.token }));
    assert.equal(saved.overall, 4);
    assert.deepEqual(saved.answers.assignment_type, ['exam', 'other']);
    assert.deepEqual(saved.answers.difficulty, ['hard']);
    assert.deepEqual(saved.answers.teacher_tags, ['humorous', 'clear', 'rigorous']);
    const tooManyTags = await request(route, { method: 'PUT', token: first.token,
      body: { overall: 1, answers: { teacher_tags: ['humorous', 'clear', 'rigorous', 'respected'] } } });
    assert.equal(tooManyTags.status, 400);
    assert.match((await tooManyTags.json()).error, /最多选择3项/);
    assert.deepEqual(await json(await request(route, { token: first.token })), saved);
    const cleared = await request(route, { method: 'PUT', token: first.token, body: {
      overall: 4, answers: { assignment_type: ['exam', 'other'], difficulty: [], teacher_tags: [] }
    } });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await json(cleared)).answers, { assignment_type: ['exam', 'other'] });
    assert.equal(await json(await request(route, { token: other.token })), null);
    const mine = await json(await request('/api/v1/student/rate/reviews', { token: first.token }));
    assert.equal(mine.reviews.length, 1);
    assert.equal(mine.reviews[0].hasGrading, false);

    const unit = await json(await request(`/api/v1/rate/units/${unitId}`));
    assert.equal(unit.reviewCount, 1);
    assert.equal(unit.average, 9);
    const assignmentStats = unit.stats.find((stat) => stat.key === 'assignment_type');
    assert.equal(assignmentStats.title, '作业/考核类型');
    assert.deepEqual(assignmentStats.options.filter((option) => option.count)
      .map((option) => [option.key, option.percent]), [['exam', 100], ['other', 100]]);
    assert.equal(JSON.stringify(unit).includes(first.accountId), false);
    const course = await json(await request('/api/v1/rate/courses/TS01'));
    assert.equal(course.units.length, 2);
    const teacher = await json(await request(`/api/v1/rate/teachers/${unit.teacher.id}`));
    assert.equal(teacher.units.length, 1);
    const search = await json(await request(`/api/v1/rate/search?q=${encodeURIComponent('艺术 张三')}`));
    assert.deepEqual(search.units.map((item) => item.id), [unitId]);
    const ranking = await json(await request(`/api/v1/rate/rankings/general?sub=${encodeURIComponent('人文类通选课')}`));
    assert.equal(ranking.items[0].id, unitId);
    assert.equal((await request('/api/v1/rate/rankings/unknown')).status, 404);
    const home = await json(await request('/api/v1/rate/home'));
    assert.equal(home.recent[0].id, unitId);
    assert.equal(home.rankings.find((item) => item.key === 'general').items.length, 1);
    const college = await json(await request(`/api/v1/rate/colleges/${encodeURIComponent('文学院')}/courses`));
    assert.equal(college.courses[0].id, 'TS01');

    reviewStore.setBlocked(first.accountId, true);
    assert.equal((await request(route, { method: 'PUT', token: first.token, body: { overall: 3 } })).status, 403);
    reviewStore.setBlocked(first.accountId, false);
    assert.equal((await request(route, { method: 'DELETE', token: other.token })).status, 404);
    assert.equal((await request(route, { method: 'DELETE', token: first.token })).status, 204);
    assert.equal((await json(await request(`/api/v1/rate/units/${unitId}`))).reviewCount, 0);

    const feedbackRoute = '/api/v1/student/rate/feedback';
    assert.equal((await request(feedbackRoute, { method: 'POST', token: first.token,
      body: { kind: 'incorrect', content: '' } })).status, 400);
    assert.equal((await request(feedbackRoute, { method: 'POST', token: first.token,
      body: { kind: 'incorrect', content: 'x'.repeat(1001) } })).status, 400);
    const feedback = await request(feedbackRoute, { method: 'POST', token: first.token,
      body: { kind: 'incorrect', unitId, content: '职称不对', appVersion: '1.0', platform: 'ios' } });
    assert.equal(feedback.status, 201);
    const feedbackId = (await json(feedback)).id;
    reviewStore.replyFeedback(feedbackId, { author: 'owner', authorId: 'admin-1', message: '已修改', status: 'replied' });
    const detail = await json(await request(`${feedbackRoute}/${feedbackId}`, { token: first.token }));
    assert.equal(detail.unit.id, unitId);
    assert.equal(detail.accountId, undefined);
    assert.deepEqual(Object.keys(detail.replies[0]).sort(), ['createdAt', 'id', 'message']);
    assert.equal((await request(`${feedbackRoute}/${feedbackId}`, { token: other.token })).status, 404);
    assert.equal((await request(`${feedbackRoute}/${feedbackId}/close`, { method: 'POST', token: other.token })).status, 404);
    assert.equal((await json(await request(`${feedbackRoute}/${feedbackId}/close`,
      { method: 'POST', token: first.token }))).status, 'closed');
    assert.equal((await json(await request(feedbackRoute, { token: other.token }))).length, 0);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
