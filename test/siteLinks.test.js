import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (page) => readFileSync(new URL(`../site/${page}`, import.meta.url), 'utf8');

for (const page of ['index.html', 'doc/terms.html', 'doc/privacy.html']) {
  test(`${page} footer credits SHUOSC and Shanghai University`, () => {
    const footer = /<footer\b[^>]*>([\s\S]*?)<\/footer>/i.exec(read(page))?.[1];
    assert.ok(footer, 'The page must have a footer');
    assert.match(footer, /Presented by <a href="https:\/\/github\.com\/shuosc"[^>]*>SHUOSC<\/a>/);
    assert.match(footer, /<a href="https:\/\/www\.shu\.edu\.cn\/"[^>]*>上海大学<\/a>/);
  });

  test(`${page} navigation links to the terms and privacy policy`, () => {
    const nav = /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(read(page))?.[1];
    assert.ok(nav, 'The page must have a navigation bar');
    assert.match(nav, /<a href="\/doc\/terms\.html"[^>]*>使用条款<\/a>/);
    assert.match(nav, /<a href="\/doc\/privacy\.html"[^>]*>隐私政策<\/a>/);
  });
}
