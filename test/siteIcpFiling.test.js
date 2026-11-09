import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

for (const page of ['index.html', 'doc/terms.html', 'doc/privacy.html']) {
  test(`${page} displays the ICP filing number linked to the official registry`, () => {
    const html = readFileSync(new URL(`../site/${page}`, import.meta.url), 'utf8');
    const footer = /<footer\b[^>]*>([\s\S]*?)<\/footer>/i.exec(html)?.[1];
    assert.ok(footer, 'The page must have a footer');
    const filing = /<a\b([^>]*)>沪ICP备2026059355号<\/a>/.exec(footer);
    assert.ok(filing, 'The official filing number must be visible in the footer');
    assert.match(filing[1], /href="https:\/\/beian\.miit\.gov\.cn\/"/);
    assert.match(filing[1], /target="_blank"/);
    assert.match(filing[1], /rel="noopener noreferrer"/);
    assert.equal(html.split('沪ICP备2026059355号').length - 1, 1);
  });
}
