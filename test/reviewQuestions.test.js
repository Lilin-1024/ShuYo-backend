import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { QUESTIONS, OMISSION_PRESERVED_QUESTION_KEYS, buildQuestionDescription } from '../src/reviewQuestions.js';

const previousQuestions = JSON.parse(readFileSync(new URL('./fixtures/reviewQuestions.v1.json', import.meta.url), 'utf8'));

// This fixture is the nine-question contract from 8a521db, independent of the new ordering.
test('questionnaire order changes without renaming any legacy question or option', () => {
  assert.deepEqual(QUESTIONS.map((question) => question.key), [
    'overall', 'attendance_freq', 'attendance_method', 'discipline', 'interaction', 'workload',
    'assignment_type', 'difficulty', 'gain', 'grading', 'teacher_tags'
  ]);
  assert.equal(new Set(QUESTIONS.map((question) => question.key)).size, QUESTIONS.length);
  for (const previous of previousQuestions) {
    const current = QUESTIONS.find((question) => question.key === previous.key);
    const { description, ...legacyFields } = current;
    assert.deepEqual(legacyFields, previous, previous.key);
  }
  assert.deepEqual(QUESTIONS.filter((question) => question.required).map((question) => question.key), ['overall']);
  assert.deepEqual(OMISSION_PRESERVED_QUESTION_KEYS, ['difficulty', 'teacher_tags']);
});

test('difficulty and teacher tags match the requested choices and optional rules', () => {
  const difficulty = QUESTIONS.find((question) => question.key === 'difficulty');
  assert.equal(difficulty.title, '课程难度');
  assert.equal(difficulty.multiple, false);
  assert.equal(difficulty.required, false);
  assert.deepEqual(difficulty.options.map((option) => [option.key, option.label]), [
    ['very_easy', '非常容易'], ['easy', '比较容易'], ['moderate', '难度适中'],
    ['hard', '比较困难'], ['very_hard', '非常困难']
  ]);
  const tags = QUESTIONS.find((question) => question.key === 'teacher_tags');
  assert.equal(tags.title, '你想送给老师的标签');
  assert.equal(tags.multiple, true);
  assert.equal(tags.required, false);
  assert.equal(tags.maxSelections, 3);
  assert.deepEqual(tags.options.map((option) => [option.key, option.label]), [
    ['humorous', '风趣幽默'], ['rigorous', '严谨认真'], ['accessible', '深入浅出'], ['inspiring', '启发思考'],
    ['by_the_book', '按部就班'], ['fast_paced', '节奏紧凑'], ['kind', '和蔼可亲'], ['respected', '令人尊敬']
  ]);
  for (const question of QUESTIONS) {
    assert.equal(new Set(question.options.map((option) => option.key)).size, question.options.length);
    assert.equal(question.preserveOnOmission, undefined);
    assert.equal(question.descriptionNote, undefined);
    assert.equal(question.descriptionOverride, undefined);
  }
});

test('description generation follows rules and supports notes or verbatim overrides', () => {
  assert.equal(buildQuestionDescription(), '单选，可跳过');
  assert.equal(buildQuestionDescription({ required: true }), '单选，必答');
  assert.equal(buildQuestionDescription({ multiple: true }), '多选，可跳过');
  assert.equal(buildQuestionDescription({ multiple: true, maxSelections: 3 }), '多选，最多三项，可跳过');
  assert.equal(buildQuestionDescription({ multiple: true, maxSelections: 2 }), '多选，最多两项，可跳过');
  assert.equal(buildQuestionDescription({ multiple: true, required: true, maxSelections: 12 }), '多选，最多十二项，必答');
  assert.equal(buildQuestionDescription({ multiple: true, maxSelections: 20 }), '多选，最多二十项，可跳过');
  assert.equal(buildQuestionDescription({ descriptionNote: '建议在出分后填写' }), '单选，可跳过（建议在出分后填写）');
  assert.equal(buildQuestionDescription({ multiple: true, maxSelections: 3, descriptionNote: '按实际感受选择' }),
    '多选，最多三项，可跳过（按实际感受选择）');
  assert.equal(buildQuestionDescription({ multiple: true, maxSelections: 3, descriptionNote: '不应追加',
    descriptionOverride: '自由说明，不改变选择规则' }), '自由说明，不改变选择规则');
  assert.equal(buildQuestionDescription({ descriptionOverride: '' }), '');
  assert.equal(QUESTIONS.find((question) => question.key === 'grading').description, '单选，可跳过（建议在出分后填写）');
  assert.equal(QUESTIONS.find((question) => question.key === 'teacher_tags').description, '多选，最多三项（如果有的话）');
});

test('invalid description rule configuration fails instead of advertising an unenforced limit', () => {
  for (const maxSelections of [0, -1, 1.5, '3', null, NaN]) {
    assert.throws(() => buildQuestionDescription({ multiple: true, maxSelections }), /maxSelections/);
  }
  assert.throws(() => buildQuestionDescription({ multiple: false, maxSelections: 3 }), /maxSelections/);
  assert.throws(() => buildQuestionDescription({ descriptionNote: null }), /descriptions/);
  assert.throws(() => buildQuestionDescription({ descriptionOverride: 3 }), /descriptions/);
});
