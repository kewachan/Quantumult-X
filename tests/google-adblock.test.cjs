const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'Rewrite/GeneralAdBlock/google-adblock.js'), 'utf8');
const script = new vm.Script(source);
const resource = fs.readFileSync(path.join(root, 'Rewrite/GeneralAdBlock/GeneralAdBlock.list'), 'utf8');
const rule = resource.split('\n').find(line => line.includes('/google-adblock.js?'));
const search = 'https://www.google.com/search?q=example&udm=14';
const app = 'https://iga.google.com/?url=googleapp%3A%2F%2Fhome&amp;campaign=example';
const card = '<div class="future-layout" role="button" data-url="' + app + '"><span>使用 Google 應用程式</span><div>Open</div></div>';
const organic = '<main id="search"><a href="https://example.com/">Ask and explore anything with the Google app</a><p>Sponsored is ordinary text here. 香港 😀</p></main>';
const footer = '<footer>Hong Kong <a href="/preferences">Settings</a></footer>';
const style = ' style="display:none!important"';
const legacy = '<div class="B2VR9 CJHX3e">Ask and explore anything with the Google app</div>';
const sponsored = '<div id="tads"><a href="/aclk?ad=example">Sponsored</a></div>';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function rewrite(body, options = {}) {
  const request = freeze({ url: options.url ?? search, method: 'GET', headers: { Cookie: 'request=keep' } });
  const response = freeze({
    body, statusCode: options.statusCode ?? 200,
    headers: options.headers ?? {
      'content-type': 'text/html; charset=UTF-8',
      'content-encoding': 'gzip',
      'content-length': '123',
      'set-cookie': 'session=keep; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Secure',
      'cache-control': 'private, max-age=0',
      'x-fixture': 'preserve'
    },
    ...(options.bodyBytes === undefined ? {} : { bodyBytes: options.bodyBytes })
  });
  const before = JSON.stringify({ request, response });
  const outputs = [];
  let prefsCalls = 0, fetchCalls = 0;
  const unexpectedPrefs = () => { prefsCalls++; throw Error('Unexpected preference access'); };
  const context = vm.createContext({
    $request: request, $response: response,
    $prefs: { valueForKey: unexpectedPrefs, setValueForKey: unexpectedPrefs, removeValueForKey: unexpectedPrefs },
    $task: { fetch() { fetchCalls++; throw Error('Unexpected HTTP request'); } },
    $done(value) { outputs.push(value); },
    setTimeout() { throw Error('Unexpected timer'); }
  });
  if (!options.withoutEnvironment) context.$environment = { sourcePath: options.sourcePath ?? rule.split(/\s+/).at(-1) };
  script.runInContext(context, { timeout: 2000 });
  assert.equal(outputs.length, 1, '$done must complete exactly once');
  assert.equal(prefsCalls, 0, 'filtering must not read or write persistent data');
  assert.equal(fetchCalls, 0, 'filtering must not make HTTP requests');
  assert.ok(JSON.stringify({ request, response }) === before, 'original request, headers and response must be unchanged');
  const patch = outputs[0];
  assert.ok(patch && typeof patch === 'object' && !Array.isArray(patch));
  assert.ok(Object.keys(patch).every(key => key === 'body'), 'only a body patch or empty pass-through is allowed');
  if (Object.hasOwn(patch, 'body')) assert.equal(typeof patch.body, 'string');
  return { patch, body: Object.hasOwn(patch, 'body') ? patch.body : body, context };
}

function passThrough(body, options) {
  const result = rewrite(body, options);
  assert.deepEqual(Object.keys(result.patch), []);
  assert.ok(result.body === body, 'pass-through must preserve the original body');
  return result;
}

function inserted(html, encoding = 'hex') {
  let literal = JSON.stringify(html);
  if (encoding === 'hex' || encoding === 'encoded-end') literal = literal.replaceAll('<', '\\x3c');
  if (encoding === 'unicode') literal = literal.replaceAll('<', '\\u003c');
  if (encoding === 'encoded-end') literal = literal.replaceAll('>', '\\x3e');
  return '<script>jsl.dh("footer",' + literal + ');</script>';
}

function payload(html) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match);
  const calls = [];
  vm.runInNewContext(match[1], { jsl: { dh(id, value) { calls.push({ id, value }); } } }, { timeout: 1000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'footer');
  assert.equal(typeof calls[0].value, 'string');
  return calls[0].value;
}

function encodeFrames(frames, prefix = ")]}'\n") {
  return prefix + frames.map(frame => frame.length.toString(16) + ';' + frame).join('');
}

function decodeFrames(text) {
  let position = text.startsWith(")]}'\n") ? 5 : 0;
  const frames = [];
  while (position < text.length) {
    const header = /^([\da-f]+);/i.exec(text.slice(position));
    assert.ok(header, 'invalid ARC frame header');
    const size = Number.parseInt(header[1], 16);
    position += header[0].length;
    assert.ok(size <= text.length - position, 'truncated ARC frame');
    frames.push(text.slice(position, position + size));
    position += size;
  }
  assert.equal(position, text.length);
  return frames;
}

function onlyHiddenStylesChanged(input, output, pagination = false) {
  const before = pagination ? decodeFrames(input) : [input];
  const after = pagination ? decodeFrames(output) : [output];
  const strip = html => html.replace(/ style=\\?"display:none!important\\?"/g, '').replaceAll('display:none!important;', '');
  const scripts = html => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(after.length, before.length);
  for (let frame = 0; frame < before.length; frame++) {
    assert.ok(strip(after[frame]) === strip(before[frame]), 'content must change only by adding hidden styles');
    const oldScripts = scripts(before[frame]), newScripts = scripts(after[frame]);
    assert.equal(newScripts.length, oldScripts.length);
    for (let i = 0; i < oldScripts.length; i++) if (oldScripts[i] !== newScripts[i]) {
      new vm.Script(oldScripts[i]);
      new vm.Script(newScripts[i]);
    }
  }
}

test('QX resource uses script-response-body, its own versioned script and a Google MITM host', () => {
  const match = /^(\S+) url (script-response-body) (\S+)$/.exec(rule);
  assert.ok(match);
  assert.equal(resource.split('\n').filter(line => line.includes('/google-adblock.js?')).length, 1);
  const pattern = new RegExp(match[1]);
  for (const url of [search, 'https://www.google.com/search', search + '&start=10&asearch=arc', search + '&async=arc_id%3Atest']) assert.ok(pattern.test(url));
  for (const url of ['https://example.com/search?q=test', 'https://www.google.com/searching', 'https://www.google.com/sorry/index', 'https://www.google.com/complete/search']) assert.equal(pattern.test(url), false);
  const url = new URL(match[3]);
  assert.equal(url.origin, 'https://raw.githubusercontent.com');
  assert.equal(url.pathname, '/kewachan/Quantumult-X/main/Rewrite/GeneralAdBlock/google-adblock.js');
  assert.match(url.searchParams.get('v'), /^\d+\.\d+\.\d+$/);
  assert.ok(resource.split('\n')[0].split(/,\s*/).includes('www.google.com'));
});

test('the complete QX adapter runs with native globals and no Surge globals', () => {
  const { body, context } = rewrite(card);
  assert.equal(body.replace(style, ''), card);
  for (const key of ['$httpClient', '$persistentStore', '$argument', 'hideGoogleAppPromotions']) assert.equal(Object.hasOwn(context, key), false);
});

test('only the app card opening tag changes; ordinary search results and footer links remain byte-identical', () => {
  const input = '<html><body>' + organic + card + footer + '</body></html>';
  const result = rewrite(input);
  assert.deepEqual(Object.keys(result.patch), ['body']);
  assert.equal(result.body.replace(style, ''), input);
  onlyHiddenStylesChanged(input, result.body);
});

test('destination matching is independent of language, class names, attribute order and HTML quotes', () => {
  for (const tag of ['div', 'a', 'button']) {
    const input = '<' + tag + " DATA-URL = '" + app + "' class='changed-layout'>別の言語</" + tag + '>';
    const first = rewrite(input).body;
    assert.equal(first.replace(" style='display:none!important'", ''), input);
    passThrough(first);
  }
});

for (const encoding of ['hex', 'unicode', 'literal', 'encoded-end']) test('JavaScript insertion remains executable with ' + encoding + ' HTML escaping', () => {
  const input = organic + inserted(card + footer, encoding);
  const output = rewrite(input).body;
  assert.equal(payload(output).replace(style, ''), card + footer);
  assert.ok(output.startsWith(organic));
  passThrough(output);
});

test('escaped slashes and HTML, hex and Unicode query separators preserve their original bytes', () => {
  for (const separator of ['&amp;', '&#38;', '&#x26;']) {
    const input = card.replace(app, 'https://iga.google.com/?campaign=example' + separator + 'url=googleapp%3A%2F%2Fhome');
    assert.equal(rewrite(input).body.replace(style, ''), input);
  }
  for (const separator of ['\\x26', '\\u0026']) {
    const input = inserted(card).replaceAll('&amp;', separator).replaceAll('https://', 'https:\\/\\/').replaceAll('com/', 'com\\/');
    assert.equal(payload(rewrite(input).body).replace(style, ''), payload(input));
  }
});

test('existing styles and dollar signs survive; plain and escaped cards are idempotent', () => {
  const styled = card.replace('role="button"', 'role="button" style="color:red;--fixture:$&"');
  for (const input of [styled, inserted(styled)]) {
    const first = rewrite(input).body;
    assert.equal(first.replace('display:none!important;', ''), input);
    passThrough(first);
  }
  passThrough(card.replace('role="button"', 'role="button" style="display:none!important;color:red"'));
});

test('ordinary mentions, normal results and empty sponsored placeholders are untouched', () => {
  for (const input of [organic + footer, '<p>Ask and explore anything with the Google app</p>',
    '<div data-note="Ask and explore anything with the Google app">Ordinary text</div>',
    '<div id="tads"></div><div id="tadsb"> &nbsp; <!-- empty --> </div>' + organic]) passThrough(input);
});

test('unrelated, similar-domain, malformed and non-home destinations are untouched', () => {
  for (const target of [
    'https://iga.google.com.evil.test/?url=googleapp%3A%2F%2Fhome',
    'https://example.com/?url=googleapp%3A%2F%2Fhome',
    'https://iga.google.com/?url=https%3A%2F%2Fexample.com',
    'https://iga.google.com/?url=googleapp%3A%2F%2Fhomepage',
    'https://iga.google.com/?url=%E0%A4%A',
    'https://iga.google.com/?campaign=example',
    'http://iga.google.com/?url=googleapp%3A%2F%2Fhome'
  ]) passThrough(card.replace(app, target));
});

test('non-200 statuses and unrelated pages finish once without replacing the response', () => {
  for (const statusCode of [201, 204, 301, 302, 304, 400, 401, 403, 404, 429, 500, 503]) passThrough(card, { statusCode });
  passThrough(card, { url: 'https://example.com/search?q=test' });
});

test('native statusCode controls rewriting and output never replaces HTTP headers', () => {
  for (const cookies of ['first=one; Secure', ['first=one; Secure', 'second=two; HttpOnly']]) {
    const headers = { 'Content-Type': 'text/html', 'Content-Encoding': 'br', 'Content-Length': '123', 'Set-Cookie': cookies, Location: '/keep' };
    assert.equal(rewrite(card, { headers }).body.replace(style, ''), card);
    passThrough(card, { statusCode: 403, headers });
    passThrough(organic, { headers });
  }
});

test('empty or missing text and binary-only responses finish without a patch', () => {
  for (const body of ['', undefined, null]) passThrough(body);
  const buffer = Uint8Array.from([0, 255, 3, 4]).buffer;
  passThrough(undefined, { bodyBytes: buffer });
  assert.deepEqual([...new Uint8Array(buffer)], [0, 255, 3, 4]);
});

test('missing or malformed sourcePath arguments never access preferences or fetch data', () => {
  for (const options of [{ withoutEnvironment: true }, { sourcePath: '' },
    { sourcePath: 'https://example.test/google-adblock.js#unknown=true' },
    { sourcePath: 'https://example.test/google-adblock.js#bad=%E0%A4%A' }]) assert.equal(rewrite(card, options).body.replace(style, ''), card);
});

test('legacy app cards and existing sponsored markers keep filtering without changing organic content', () => {
  for (const tag of [sponsored, '<section data-text-ad="1"><a href="/aclk?x=1">Ad</a></section>',
    '<div jscontroller="tY2w9d">Ad</div>', '<div jsname="ix0Hvc">Ad</div>']) {
    const first = rewrite(tag + organic).body;
    assert.equal(first.replace(style, ''), tag + organic);
    passThrough(first);
  }
  assert.equal(rewrite(legacy + organic).body.replace(style, ''), legacy + organic);
});

test('legacy cards are also idempotent with either class order and literal or escaped HTML', () => {
  for (const classes of ['B2VR9 CJHX3e', 'CJHX3e B2VR9']) {
    const html = legacy.replace('B2VR9 CJHX3e', classes);
    for (const input of [html + organic, inserted(html + footer)]) {
      const first = rewrite(input).body;
      passThrough(first);
      if (input.startsWith('<script>')) assert.equal(payload(first).replace(style, ''), html + footer);
      else assert.equal(first.replace(style, ''), input);
    }
  }
});

test('already hidden and visible cards coexist without suppressing other cards or repeated styles', () => {
  const hidden = rewrite(card).body, input = hidden + card + legacy + organic;
  const first = rewrite(input).body;
  assert.equal(first.split('display:none!important').length - 1, 3);
  assert.ok(first.endsWith(organic));
  passThrough(first);
});

test('ARC pagination preserves Unicode and unrelated frames and updates every modified frame length', () => {
  const frames = [organic, card, inserted(card), sponsored, footer];
  for (const prefix of [")]}'\n", '']) for (const query of ['asearch=arc', 'async=arc_id:test', 'async=arc_id%3Atest']) {
    const input = encodeFrames(frames, prefix), options = { url: search + '&start=10&' + query, headers: { 'Content-Type': 'text/plain' } };
    const output = rewrite(input, options).body, decoded = decodeFrames(output);
    assert.equal(output.startsWith(")]}'\n"), prefix !== '');
    onlyHiddenStylesChanged(input, output, true);
    assert.equal(decoded.length, frames.length);
    assert.equal(decoded[0], organic);
    assert.equal(decoded[4], footer);
    assert.equal(decoded[1].replace(style, ''), card);
    assert.equal(payload(decoded[2]).replace(style, ''), card);
    assert.equal(decoded[3].replace(style, ''), sponsored);
    passThrough(output, options);
  }
});

test('malformed, truncated or unsupported ARC data passes through as a whole', () => {
  const valid = encodeFrames([card, footer]);
  for (const input of [valid.slice(0, -1), valid + 'invalid', 'zz;invalid', 'ffff;short', '10;short',
    card, encodeFrames([card]) + 'ffff;short', '0;z', '0'.repeat(128) + 'f;short']) {
    passThrough(input, { url: search + '&asearch=arc' });
  }
});

test('valid ARC responses without targeted content remain completely untouched', () => {
  for (const input of [encodeFrames([organic, footer]), ")]}'\n", '', '0;']) passThrough(input, { url: search + '&asearch=arc' });
});

test('large organic HTML completes without a body patch or asynchronous work', () => {
  passThrough(organic.repeat(2000) + footer);
});

test('optional private HAR replay preserves refusals and changes only targeted style bytes', {
  skip: !process.env.QX_GOOGLE_ADBLOCK_HAR_PATHS
}, () => {
  const files = JSON.parse(process.env.QX_GOOGLE_ADBLOCK_HAR_PATHS);
  assert.ok(Array.isArray(files) && files.length > 0);
  let replayed = 0, changed = 0, refused = 0;
  for (const file of files) for (const entry of JSON.parse(fs.readFileSync(file, 'utf8')).log.entries) {
    const url = new URL(entry.request.url);
    if (url.hostname !== 'www.google.com' || url.pathname !== '/search' || !entry.response) continue;
    const content = entry.response.content || {};
    const input = content.encoding === 'base64' ? Buffer.from(content.text || '', 'base64').toString('utf8') : content.text || '';
    const output = rewrite(input, { url: entry.request.url, statusCode: entry.response.status }).body;
    replayed++;
    if (entry.response.status === 403) {
      refused++;
      assert.ok(output === input, 'captured refusal must be unchanged');
    }
    if (output === input) continue;
    changed++;
    const pagination = url.searchParams.get('asearch') === 'arc' || (url.searchParams.get('async') || '').startsWith('arc_id:');
    onlyHiddenStylesChanged(input, output, pagination);
  }
  assert.ok(replayed > 0 && changed > 0 && refused > 0, 'fixtures must include a changed promotion and an HTTP refusal');
});
