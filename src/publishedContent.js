import MarkdownIt from 'markdown-it';

const imagePath = /^\/api\/v1\/tips\/images\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/;
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });

function visible(item) {
  return item.active !== false && !item.deletedAt;
}

function ordered(items) {
  return [...items].sort((a, b) =>
    (Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)) ||
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

function publicItems(items) {
  return ordered(items.filter(visible));
}

function latestAnnouncement(items) {
  return [...items].filter(visible).sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
}

function nextSortOrder(items) {
  return Math.min(0, ...items.map((item) => Number(item.sortOrder ?? 0))) - 10;
}

function moveItem(items, id, direction) {
  const orderedItems = publicItems(items);
  const index = orderedItems.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const target = index + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0);
  if (target < 0 || target >= orderedItems.length) return false;
  const [item] = orderedItems.splice(index, 1);
  orderedItems.splice(target, 0, item);
  orderedItems.forEach((entry, position) => { entry.sortOrder = position * 10; });
  return true;
}

function validateTipMarkdown(source) {
  const text = String(source ?? '');
  if (text.length > 12000) throw new Error('提示正文不能超过 12000 个字符。');
  const blocks = markdown.parse(text, {});
  function inspect(tokens) {
    for (const token of tokens) {
      if (token.type === 'image' && !imagePath.test(token.attrGet('src') ?? '')) {
        throw new Error('图片只允许使用后台上传后生成的地址。');
      }
      if (token.children) inspect(token.children);
    }
  }
  inspect(blocks);
  return text;
}

function renderTipMarkdown(source) {
  validateTipMarkdown(source);
  return markdown.render(source);
}

function imageType(buffer) {
  if (buffer.length >= 24 &&
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      buffer.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (buffer.length >= 4 && buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])) &&
      buffer.subarray(-2).equals(Buffer.from([255, 217]))) return 'jpg';
  if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export { imagePath, imageType, latestAnnouncement, moveItem, nextSortOrder,
  ordered, publicItems, renderTipMarkdown, validateTipMarkdown, visible };
