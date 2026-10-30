const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const rules = fs.readFileSync(path.join(__dirname, '../Rewrite/Adrewrite.list'), 'utf8')
  .split('\n').map(line => /^(.*?) url 302 (.*)$/.exec(line))
  .filter(match => match && match[1].includes('google'))
  .map(match => ({ pattern: new RegExp(match[1]), replacement: match[2] }));
function redirect(url) {
  const rule = rules.find(rule => rule.pattern.test(url));
  return rule ? url.replace(rule.pattern, rule.replacement) : url;
}

test('Mac Safari client-first searches use Hong Kong and retain query data', () => {
  for (const tail of ['q=Mac%20Safari', 'rls=en&q=C%2B%2B%20%26%20Mac&ie=UTF-8&oe=UTF-8&start=10']) {
    const input = 'https://www.google.com/search?client=safari&' + tail + '#results';
    const output = redirect(input), parsed = new URL(output), before = new URL(input);
    assert.equal(parsed.searchParams.get('gl'), 'hk');
    assert.equal(parsed.searchParams.get('safe'), 'off');
    assert.equal(parsed.searchParams.get('udm'), '14');
    assert.equal(parsed.searchParams.has('client'), false);
    for (const [key, value] of before.searchParams) if (key !== 'client') assert.equal(parsed.searchParams.get(key), value);
    assert.equal(parsed.hash, '#results');
    assert.equal(redirect(output), output);
  }
});

test('existing iOS query-first searches retain the same redirect', () => {
  const input = 'https://www.google.com/search?q=Mac%20Safari&client=safari&start=10&ei=keep#results';
  assert.equal(redirect(input), 'https://www.google.com/search?q=Mac%20Safari&start=10&ei=keep&gl=hk&safe=off&udm=14#results');
});

test('explicit image, AI and other search modes are retained without redirects', () => {
  for (const mode of ['udm=2', 'udm=14', 'udm=50', 'tbm=isch', 'tbm=nws']) {
    for (const query of ['client=safari&rls=en&q=test&', 'q=test&client=safari&']) {
      const input = 'https://www.google.com/search?' + query + mode;
      assert.equal(redirect(input), input);
    }
  }
});

test('the existing client-free fallback stays idempotent and preserves parameters', () => {
  const input = 'https://www.google.com/search?ei=keep&q=test&start=10#results';
  const output = redirect(input);
  assert.equal(output, 'https://www.google.com/search?udm=14&ei=keep&q=test&start=10#results');
  assert.equal(redirect(output), output);
});

test('non-search pages, missing queries and unrelated domains are untouched', () => {
  for (const input of ['https://www.google.com/search?client=safari&q=',
    'https://www.google.com/search?client=safari&rls=en',
    'https://www.google.com/about?client=safari&q=test',
    'https://example.com/search?client=safari&q=test']) assert.equal(redirect(input), input);
});
