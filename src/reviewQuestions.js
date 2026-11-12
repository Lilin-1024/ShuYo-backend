// Question and option keys are stored with each answer; never rename a key.
// Array order controls presentation only. Keep every existing option when reordering.
// descriptionNote appends to the generated hint; descriptionOverride replaces it
// (including an empty string). Neither changes the actual validation rules.
const DEFINITIONS = [
  { key: 'overall', title: '总体评价', multiple: false, required: true, options: [
    ['1', '不推荐'], ['2', '谨慎选择'], ['3', '中规中矩'], ['4', '值得一选'], ['5', '强烈推荐']] },
  { key: 'attendance_freq', title: '签到频率', multiple: false, options: [
    ['every_class', '每节课'], ['often', '经常'], ['sometimes', '偶尔'], ['never', '从不']] },
  { key: 'attendance_method', title: '签到方式', multiple: true, options: [
    ['qr', '扫码签到'], ['location', '位置签到'], ['other_xxt', '其他学习通签到方式'],
    ['roster', '座位表/签名册'], ['quiz', '小测'], ['other', '其他']] },
  { key: 'discipline', title: '纪律要求', multiple: false, options: [
    ['relaxed', '比较宽松'], ['normal', '正常要求'], ['strict', '极其严格']] },
  { key: 'interaction', title: '互动情况', multiple: false, options: [
    ['lecture', '讲授为主'], ['light', '简单互动'], ['frequent', '经常提问']] },
  { key: 'workload', title: '作业量', multiple: false, options: [
    ['none', '几乎没有'], ['occasional', '偶尔有'], ['regular', '规律适中'], ['heavy', '极其繁重']] },
  { key: 'assignment_type', title: '作业/考核类型', multiple: true, options: [
    ['problems', '题目'], ['presentation', 'pre'], ['paper', '论文'], ['group', '小组作业'], ['exam', '考试'], ['other', '其他']] },
  { key: 'difficulty', title: '课程难度', multiple: false, preserveOnOmission: true, options: [
    ['very_easy', '非常容易'], ['easy', '比较容易'], ['moderate', '难度适中'], ['hard', '比较困难'], ['very_hard', '非常困难']] },
  { key: 'gain', title: '课堂收获', multiple: false, options: [
    ['rich', '干货满满'], ['average', '中规中矩'], ['self_study', '倾向自学']] },
  { key: 'grading', title: '给分倾向', multiple: false, descriptionNote: '建议在出分后填写', options: [
    ['generous', '慷慨大方'], ['normal', '正常给分'], ['strict', '给分较严'], ['random', '玄学给分']] },
  { key: 'teacher_tags', title: '你想送给老师的标签', multiple: true, maxSelections: 3,
    descriptionOverride: '多选，最多三项（如果有的话）', preserveOnOmission: true, options: [
      ['humorous', '风趣幽默'], ['clear', '条理清晰'], ['accessible', '深入浅出'], ['inspiring', '启发思考'],
      ['by_the_book', '按部就班'], ['fast_paced', '节奏紧凑'], ['rigorous', '严谨认真'], ['respected', '令人尊敬']] }
];

function selectionCountText(count) {
  const digits = '零一二三四五六七八九';
  if (count === 2) return '两';
  if (count < 10) return digits[count];
  if (count < 100) return `${count < 20 ? '' : digits[Math.floor(count / 10)]}十${count % 10 ? digits[count % 10] : ''}`;
  return String(count);
}

function buildQuestionDescription({ multiple = false, required = false, maxSelections,
  descriptionNote = '', descriptionOverride } = {}) {
  if (maxSelections !== undefined && (!multiple || !Number.isInteger(maxSelections) || maxSelections < 1)) {
    throw new Error('maxSelections must be a positive integer on a multiple-choice question');
  }
  if (typeof descriptionNote !== 'string' || (descriptionOverride !== undefined && typeof descriptionOverride !== 'string')) {
    throw new Error('Question descriptions must be strings');
  }
  if (descriptionOverride !== undefined) return descriptionOverride;
  const parts = [multiple ? '多选' : '单选'];
  if (maxSelections !== undefined) parts.push(`最多${selectionCountText(maxSelections)}项`);
  parts.push(required ? '必答' : '可跳过');
  return parts.join('，') + (descriptionNote ? `（${descriptionNote}）` : '');
}

const QUESTIONS = DEFINITIONS.map((definition) => {
  const { descriptionNote, descriptionOverride, preserveOnOmission, ...question } = definition;
  if (question.maxSelections > question.options.length) throw new Error('maxSelections exceeds the option count');
  return {
    ...question,
    required: Boolean(question.required),
    description: buildQuestionDescription(definition),
    options: question.options.map(([key, label]) => ({ key, label }))
  };
});

// Old clients may submit cached questionnaires without these newer fields.
// Missing means keep the existing answer; explicitly send [] to clear it.
const OMISSION_PRESERVED_QUESTION_KEYS = DEFINITIONS.filter((question) => question.preserveOnOmission)
  .map((question) => question.key);

export { QUESTIONS, OMISSION_PRESERVED_QUESTION_KEYS, buildQuestionDescription };
