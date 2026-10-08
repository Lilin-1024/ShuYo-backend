import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

test('upload inserts Markdown without submitting or clearing the draft', async () => {
  let onSubmit;
  let resetCount = 0;
  let prevented = false;
  let fetchOptions;
  const title = { value: '写了一半的标题' };
  const editor = {
    value: '已有正文',
    selectionStart: 4,
    selectionEnd: 4,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    dispatchEvent() {},
    focus() {},
  };
  const button = { disabled: false };
  const form = {
    action: '/admin/tips/images',
    addEventListener(type, callback) { if (type === 'submit') onSubmit = callback; },
    querySelector() { return button; },
    reset() { resetCount++; },
  };
  const status = { textContent: '' };
  const document = {
    getElementById(id) { return id === 'tip-image-upload' ? form : status; },
    querySelector() { return editor; },
    addEventListener() {},
  };
  const script = readFileSync(new URL('../src/adminTipEditor.js', import.meta.url), 'utf8');
  runInNewContext(script, {
    document,
    FormData: class { constructor(receivedForm) { assert.equal(receivedForm, form); } },
    Event: class {},
    fetch: async (url, options) => {
      assert.equal(url, '/admin/tips/images');
      fetchOptions = options;
      return {
        ok: true,
        json: async () => ({
          data: { url: '/api/v1/tips/images/00000000-0000-4000-8000-000000000001.png' }
        }),
      };
    },
  });
  await onSubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(title.value, '写了一半的标题');
  assert.match(editor.value, /已有正文/);
  assert.match(editor.value, /!\[图片\]\(\/api\/v1\/tips\/images\//);
  assert.equal(fetchOptions.method, 'POST');
  assert.equal(resetCount, 1);
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /已插入/);
});
