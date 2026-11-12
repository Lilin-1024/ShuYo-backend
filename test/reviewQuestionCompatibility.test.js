import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReviewStore } from '../src/reviewStore.js';

const legacyQuestions = JSON.parse(readFileSync(new URL('./fixtures/reviewQuestions.v1.json', import.meta.url), 'utf8'));
const catalog = [{ 课程号: 'TEST01', 课程名称: '测试课程', 课程性质: '公共基础课', 开课学院: '测试学院',
  教学班ID: 'TEST-S1', 课程学分: '2', 上课教师工号: '1001', 上课教师姓名: '测试教师', 教师职称: '讲师' }];

function createStore(filename = ':memory:') {
  const store = new ReviewStore({ filename });
  store.importCatalog(catalog, '2026-2027-1');
  return { store, unitId: store.course('TEST01').units[0].id };
}

function databaseState(store) {
  return {
    version: store.db.prepare('PRAGMA user_version').get().user_version,
    schema: store.db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all(),
    reviews: store.db.prepare('SELECT * FROM reviews ORDER BY id').all(),
    answers: store.db.prepare('SELECT rowid, * FROM review_answers ORDER BY rowid').all(),
    units: store.db.prepare('SELECT * FROM units ORDER BY id').all()
  };
}

test('opening existing v1 answers preserves all rows, schema, identities and legacy statistics', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-question-upgrade-'));
  const filename = path.join(directory, 'reviews.sqlite');
  let store;
  try {
    ({ store } = createStore(filename));
    const unitId = store.course('TEST01').units[0].id;
    const expected = [];
    // Write the previous release's question keys directly, without the new validator.
    for (let index = 0; index < 6; index++) {
      const account = `legacy-${index}`;
      const overall = index % 5 + 1;
      const at = `2026-11-0${index + 1}T00:00:00.000Z`;
      const answers = {};
      store.db.prepare('INSERT INTO reviews(id, unit_id, account_id, overall, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`rv_${account}`, unitId, account, overall, at, at);
      for (const question of legacyQuestions.filter((question) => question.key !== 'overall')) {
        const selected = [question.options[index % question.options.length].key];
        if (question.multiple) selected.push(question.options[(index + 1) % question.options.length].key);
        answers[question.key] = selected;
        for (const option of selected) {
          store.db.prepare('INSERT INTO review_answers(review_id, question, option) VALUES (?, ?, ?)')
            .run(`rv_${account}`, question.key, option);
        }
      }
      expected.push({ account, overall, answers, at });
    }
    store.refreshUnits([unitId]);
    const before = databaseState(store);
    store.close();
    store = new ReviewStore({ filename });
    assert.deepEqual(databaseState(store), before);
    assert.equal(before.version, 1);
    for (const previous of expected) {
      const current = store.myReview(previous.account, unitId);
      assert.equal(current.id, `rv_${previous.account}`);
      assert.equal(current.overall, previous.overall);
      assert.deepEqual(current.answers, previous.answers);
      assert.equal(current.createdAt, previous.at);
      assert.equal(current.updatedAt, previous.at);
    }
    const detail = store.unit(unitId);
    assert.equal(detail.reviewCount, expected.length);
    assert.equal(detail.average, 7.7);
    for (const question of legacyQuestions) {
      const stat = detail.stats.find((stat) => stat.key === question.key);
      assert.equal(stat.answered, expected.length);
      for (const option of question.options) {
        const count = expected.filter((review) => question.key === 'overall'
          ? String(review.overall) === option.key : review.answers[question.key].includes(option.key)).length;
        assert.equal(stat.options.find((item) => item.key === option.key).count, count);
      }
    }
    for (const key of ['difficulty', 'teacher_tags']) {
      const stat = detail.stats.find((stat) => stat.key === key);
      assert.equal(stat.answered, 0);
      assert.ok(stat.options.every((option) => option.count === 0 && option.percent === 0 && !option.top));
    }
    assert.deepEqual(databaseState(store), before);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('new choices validate, deduplicate and count actual respondents without limiting older multi-selects', () => {
  const { store, unitId } = createStore();
  try {
    store.saveReview('skip', unitId, { overall: 4 });
    for (let count = 0; count <= 3; count++) {
      store.saveReview(`tags-${count}`, unitId, { overall: 4, answers: {
        difficulty: 'moderate', teacher_tags: ['humorous', 'rigorous', 'inspiring'].slice(0, count)
      } });
    }
    const duplicate = store.saveReview('deduplicated', unitId, { overall: 4, answers: {
      teacher_tags: ['humorous', 'rigorous', 'inspiring', 'humorous']
    } }).review;
    assert.deepEqual(duplicate.answers.teacher_tags, ['humorous', 'rigorous', 'inspiring']);
    const beforeInvalid = databaseState(store);
    assert.throws(() => store.saveReview('deduplicated', unitId, { overall: 1, answers: {
      teacher_tags: ['humorous', 'rigorous', 'inspiring', 'kind']
    } }), /最多选择3项/);
    assert.throws(() => store.saveReview('invalid', unitId, { overall: 4, answers: { teacher_tags: ['unknown'] } }), /选项无效/);
    assert.throws(() => store.saveReview('invalid', unitId, { overall: 4, answers: { difficulty: 'unknown' } }), /选项无效/);
    assert.throws(() => store.saveReview('invalid', unitId, { overall: 4, answers: { difficulty: ['easy', 'hard'] } }), /只能选一项/);
    assert.deepEqual(databaseState(store), beforeInvalid);
    store.saveReview('legacy-multi', unitId, { overall: 4, answers: {
      attendance_method: ['qr', 'location', 'other_xxt', 'roster', 'quiz', 'other'],
      assignment_type: ['problems', 'presentation', 'paper', 'group', 'exam', 'other']
    } });
    const stats = Object.fromEntries(store.unit(unitId).stats.map((stat) => [stat.key, stat]));
    assert.equal(stats.difficulty.answered, 4);
    assert.equal(stats.teacher_tags.answered, 4);
    assert.deepEqual(stats.teacher_tags.options.filter((option) => option.count)
      .map((option) => [option.key, option.count, option.percent]),
    [['humorous', 4, 100], ['rigorous', 3, 75], ['inspiring', 2, 50]]);
    assert.equal(stats.assignment_type.answered, 1);
    assert.ok(stats.assignment_type.options.every((option) => option.count === 1));
  } finally {
    store.close();
  }
});

test('legacy or cached submissions preserve omitted new answers while explicit empty arrays clear them', () => {
  const { store, unitId } = createStore();
  try {
    store.saveReview('existing', unitId, { overall: 5, answers: {
      difficulty: 'hard', teacher_tags: ['humorous', 'rigorous'], workload: 'heavy', assignment_type: ['exam']
    } });
    const preservedRows = () => store.db.prepare("SELECT rowid, * FROM review_answers WHERE question IN ('difficulty', 'teacher_tags') ORDER BY rowid").all();
    const before = preservedRows();
    store.saveReview('existing', unitId, { overall: 4, answers: { workload: 'none' } });
    assert.deepEqual(preservedRows(), before);
    assert.deepEqual(store.myReview('existing', unitId).answers, {
      difficulty: ['hard'], teacher_tags: ['humorous', 'rigorous'], workload: ['none']
    });
    store.saveReview('existing', unitId, { overall: 3, answers: { difficulty: [] } });
    assert.deepEqual(store.myReview('existing', unitId).answers, { teacher_tags: ['humorous', 'rigorous'] });
    store.saveReview('existing', unitId, { overall: 3 });
    assert.deepEqual(store.myReview('existing', unitId).answers, { teacher_tags: ['humorous', 'rigorous'] });
    store.saveReview('existing', unitId, { overall: 3, answers: { difficulty: 'easy', teacher_tags: ['respected'] } });
    assert.deepEqual(store.myReview('existing', unitId).answers, { difficulty: ['easy'], teacher_tags: ['respected'] });
    store.saveReview('existing', unitId, { overall: 3, answers: { difficulty: [], teacher_tags: [] } });
    assert.deepEqual(store.myReview('existing', unitId).answers, {});
    assert.equal(store.unit(unitId).reviewCount, 1);
    assert.equal(store.unit(unitId).stats.find((stat) => stat.key === 'teacher_tags').answered, 0);
  } finally {
    store.close();
  }
});


test('retiring clear preserves rigorous identities, other answers and schema across repeated opens', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-tag-retirement-'));
  const filename = path.join(directory, 'reviews.sqlite');
  let store;
  try {
    let unitId;
    ({ store, unitId } = createStore(filename));
    for (const [account, tags] of [
      ['both', ['rigorous', 'humorous']], ['retired-only', []], ['rigorous-only', ['rigorous']]
    ]) {
      const { review } = store.saveReview(account, unitId, { overall: 4,
        answers: { teacher_tags: tags, workload: 'heavy', difficulty: 'hard' } });
      if (account !== 'rigorous-only') {
        // The preceding release stored clear and rigorous as distinct choices.
        store.db.prepare('INSERT INTO review_answers(review_id, question, option) VALUES (?, ?, ?)')
          .run(review.id, 'teacher_tags', 'clear');
      }
    }
    const before = databaseState(store);
    const expected = { ...before, answers: before.answers.filter((answer) =>
      !(answer.question === 'teacher_tags' && answer.option === 'clear')) };
    store.close();
    store = new ReviewStore({ filename });
    assert.deepEqual(databaseState(store), expected);
    assert.deepEqual(store.myReview('both', unitId).answers.teacher_tags, ['rigorous', 'humorous']);
    assert.equal(store.myReview('retired-only', unitId).answers.teacher_tags, undefined);
    assert.deepEqual(store.myReview('rigorous-only', unitId).answers.teacher_tags, ['rigorous']);
    const stats = store.unit(unitId).stats.find((stat) => stat.key === 'teacher_tags');
    assert.equal(stats.answered, 2);
    assert.equal(stats.options.some((option) => option.key === 'clear'), false);
    assert.deepEqual(stats.options.filter((option) => option.count)
      .map((option) => [option.key, option.label, option.count, option.percent]), [
      ['humorous', '风趣幽默', 1, 50], ['rigorous', '严谨认真', 2, 100]
    ]);
    assert.equal(stats.options.find((option) => option.key === 'kind').count, 0);
    store.close();
    store = new ReviewStore({ filename });
    assert.deepEqual(databaseState(store), expected);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cached retired choices are discarded without reinterpreting rigorous or weakening active limits', () => {
  const { store, unitId } = createStore();
  try {
    const { review } = store.saveReview('cached', unitId, { overall: 4, answers: {
      teacher_tags: ['clear', 'rigorous', 'kind', 'humorous', 'clear']
    } });
    assert.deepEqual(review.answers.teacher_tags, ['rigorous', 'kind', 'humorous']);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM review_answers WHERE question = 'teacher_tags' AND option = 'clear'").get().n, 0);
    store.saveReview('cached', unitId, { overall: 5 });
    assert.deepEqual(store.myReview('cached', unitId).answers.teacher_tags, ['rigorous', 'kind', 'humorous']);
    assert.throws(() => store.saveReview('cached', unitId, { overall: 4, answers: {
      teacher_tags: ['clear', 'rigorous', 'kind', 'humorous', 'inspiring']
    } }), /最多选择3项/);
    store.saveReview('cached', unitId, { overall: 4, answers: { teacher_tags: ['clear'] } });
    assert.equal(store.myReview('cached', unitId).answers.teacher_tags, undefined);
    assert.equal(store.unit(unitId).stats.find((stat) => stat.key === 'teacher_tags').answered, 0);
  } finally {
    store.close();
  }
});
