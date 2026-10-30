const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const playerURL = 'https://i2.bahamut.com.tw/build/js/anime_player.js';
const pageURL = 'https://ani.gamer.com.tw/animeVideo.php?sn=51957';
const play = 'play(a,u,m){this.#t=a,this.#i=u,this.#e=m,this.#u={},this.#o=!1,this.#l=[],this.#d()}';
const destroy = 'destroy(){this.#s&&this.#s.destroy(),this.#a&&this.#a.destroy(),this.#r&&this.#r.destroy(),this.#n&&this.#n.destroy()}';
const fixture = (playMethod = play, destroyMethod = destroy) => `globalThis.Handler=class {
  #t;#i;#e;#u;#o;#l;#s;#a;#r;#n;
  fallback=0; originalDestroyCalls=0; showCalls=0;
  constructor(){this.#s={destroy:()=>this.originalDestroyCalls++}}
  #d(){this.fallback++}
  #E(){this.showCalls++}
  ${playMethod}${destroyMethod}
}`;
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function rewrite(file, body, options = {}) {
  const outputs = [], requests = [];
  const context = {
    $request: { url: options.url || playerURL, headers: options.requestHeaders || {} },
    $response: { body, statusCode: options.statusCode ?? 200, headers: options.headers || {} },
    $environment: { sourcePath: '' },
    $done(value) { outputs.push(value); },
    $prefs: { valueForKey() { return null; }, setValueForKey() {}, removeValueForKey() {} },
    $task: { fetch(request) { requests.push(request); throw Error('Unexpected network request'); } },
    console: { log() {} },
    setTimeout() { throw Error('Unexpected rewrite-side timer'); },
    clearTimeout() {}
  };
  vm.runInNewContext(read('Rewrite/GeneralAdBlock/' + file), context, { timeout: 2000 });
  assert.equal(outputs.length, 1, 'rewrite must finish exactly once');
  return { output: outputs[0], requests };
}

function clock() {
  let now = 0, nextID = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, ms) { const id = ++nextID; timers.set(id, { fn, at: now + ms, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await tick();
      for (let count = 0; count < 100; count++) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = end; await tick(); return; }
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await tick();
      }
      throw Error('Too many timers');
    }
  };
}

function setup(fetch, options = {}) {
  const { output } = rewrite('bahamut-web.js', options.source || fixture());
  assert.equal(typeof output.body, 'string', 'known upstream player should be rewritten');
  const time = clock();
  const context = vm.createContext({
    AbortController: options.withoutAbortController ? undefined : AbortController,
    fetch, encodeURIComponent, Ai: { SHOW: 1 },
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout
  });
  new vm.Script(output.body).runInContext(context);
  return { handler: new context.Handler(), time };
}

function rules(file) {
  return read('Rewrite/' + file).split('\n').flatMap((line, index) => {
    if (!line.trim() || /^(?:#|hostname\s*=)/.test(line)) return [];
    const match = /^(.*?) (url(?:-and-header)?) (\S+)(?: (.*))?$/.exec(line);
    assert(match, file + ':' + (index + 1));
    const condition = match[2] === 'url-and-header' ? /^(.*) (\S+)$/.exec(match[1]) : null;
    const source = condition ? condition[1] : match[1];
    // JS lacks ICU atomic groups. Expanding them is conservative for the no-reject
    // assertions: it can add rejection candidates, never hide a required resource hit.
    const regex = new RegExp(source.replace(/^\(\?i\)/, '').replaceAll('(?>', '(?:'), source.startsWith('(?i)') ? 'i' : '');
    return [{ regex, source, action: match[3], value: match[4], file, line: index + 1 }];
  });
}
const resourceFiles = ['Adrewrite.list', 'Advertising.list', 'GeneralAdBlock/GeneralAdBlock.list', 'Youtube/YouTube.Enhance.list', 'Bilibili/Bilibili.Enhance.list'];
const requestRejects = files => files.flatMap(rules).filter(rule => /^reject/.test(rule.action));

test('normal free playback validates start and end once, preserving the 31-second server wait', async () => {
  const requests = [], completed = [];
  const { handler, time } = setup(async (url, options) => { requests.push({ url, options }); return { ok: true }; });
  handler.play(51957, { enableAd: true, adSid: 'ad/123' }, () => completed.push(51957));
  await tick();
  assert.deepEqual(requests.map(r => r.url), ['/ajax/videoCastcishu.php?s=ad%2F123&sn=51957']);
  await time.advance(30999); assert.equal(completed.length, 0);
  await time.advance(1);
  assert.deepEqual(requests.map(r => r.url), ['/ajax/videoCastcishu.php?s=ad%2F123&sn=51957', '/ajax/videoCastcishu.php?s=ad%2F123&sn=51957&ad=end']);
  assert.deepEqual(completed, [51957]); assert.equal(handler.fallback, 0);
  assert.equal(time.timers.size, 0);
  assert(requests.every(r => r.options.credentials !== 'omit'));
});

test('already validated and paid ad-free playback starts immediately without validation or ad media', () => {
  let completed = 0;
  const { handler, time } = setup(() => { throw Error('Unexpected fetch'); });
  handler.play(51957, { enableAd: false }, () => completed++);
  assert.equal(completed, 1); assert.equal(handler.fallback, 0); assert.equal(time.timers.size, 0);
});

for (const stage of ['start', 'end']) test(stage + ' validation HTTP failure restores the original ad handler', async () => {
  let count = 0, completed = 0;
  const { handler, time } = setup(async () => ({ ok: ++count !== (stage === 'start' ? 1 : 2), status: 503 }));
  handler.play(51957, { enableAd: true, adSid: 123 }, () => completed++);
  await tick(); if (stage === 'end') await time.advance(31000);
  assert.equal(handler.fallback, 1); assert.equal(completed, 0); assert.equal(time.timers.size, 0);
});

for (const stage of ['start', 'end']) test(stage + ' validation cannot stall playback when fetch never settles', async () => {
  const pending = deferred(); let count = 0, signal, completed = 0;
  const { handler, time } = setup((url, options) => {
    signal = options.signal;
    return ++count === (stage === 'start' ? 1 : 2) ? pending.promise : Promise.resolve({ ok: true });
  });
  handler.play(51957, { enableAd: true, adSid: 123 }, () => completed++);
  await tick(); if (stage === 'end') await time.advance(31000);
  await time.advance(10000);
  assert.equal(handler.fallback, 1); assert.equal(completed, 0);
  assert.equal(signal.aborted, true); assert.equal(time.timers.size, 0);
  pending.resolve({ ok: true }); await tick(); await time.advance(60000);
  assert.equal(handler.fallback, 1); assert.equal(completed, 0);
});

test('synchronous fetch errors also restore the original player', async () => {
  const { handler, time } = setup(() => { throw Error('Network unavailable'); });
  assert.doesNotThrow(() => handler.play(51957, { enableAd: true, adSid: 123 }, () => assert.fail('Unvalidated playback')));
  await tick(); assert.equal(handler.fallback, 1); assert.equal(time.timers.size, 0);
});

test('missing browser validation support preserves the original player', () => {
  const { handler, time } = setup(undefined, { withoutAbortController: true });
  assert.doesNotThrow(() => handler.play(51957, { enableAd: true, adSid: 123 }, () => assert.fail('Unvalidated playback')));
  assert.equal(handler.fallback, 1); assert.equal(time.timers.size, 0);
});

test('missing or invalid ad session data uses the original handler without issuing invalid validation requests', () => {
  for (const adSid of [undefined, null, {}, '', '  ', NaN, Infinity]) {
    const { handler, time } = setup(() => assert.fail('Invalid validation request'));
    handler.play(51957, { enableAd: true, adSid }, () => assert.fail('Unvalidated playback'));
    assert.equal(handler.fallback, 1); assert.equal(time.timers.size, 0);
  }
});

for (const phase of ['request', 'wait', 'end']) test('destroy during validation ' + phase + ' cancels all old callbacks and preserves original cleanup', async () => {
  const requests = [], pending = deferred(); let completed = 0;
  const { handler, time } = setup((url, options) => {
    requests.push({ url, options });
    return phase === 'request' || phase === 'end' && requests.length === 2 ? pending.promise : Promise.resolve({ ok: true });
  });
  handler.play(1, { enableAd: true, adSid: 123 }, () => completed++); await tick();
  if (phase === 'end') await time.advance(31000);
  handler.destroy();
  assert.equal(requests.at(-1).options.signal.aborted, true); assert.equal(time.timers.size, 0);
  assert.equal(handler.originalDestroyCalls, 1);
  pending.resolve({ ok: true }); await tick(); await time.advance(60000);
  assert.equal(requests.length, phase === 'end' ? 2 : 1); assert.equal(completed, 0); assert.equal(handler.fallback, 0);
});

test('playing a new ad-free episode on the same handler cannot later start the old episode', async () => {
  const requests = [], completed = [];
  const { handler, time } = setup(async (url, options) => { requests.push({ url, options }); return { ok: true }; });
  handler.play(1, { enableAd: true, adSid: 123 }, () => completed.push(1)); await tick();
  handler.play(2, { enableAd: false }, () => completed.push(2)); await tick();
  assert.equal(requests[0].options.signal.aborted, true);
  await time.advance(60000);
  assert.deepEqual(completed, [2]); assert.equal(requests.length, 1); assert.equal(time.timers.size, 0);
});

test('playing another free episode cancels stale validation and validates only the new episode', async () => {
  const requests = [], completed = [];
  const { handler, time } = setup(async (url, options) => { requests.push({ url, options }); return { ok: true }; });
  handler.play(1, { enableAd: true, adSid: 123 }, () => completed.push(1)); await tick();
  handler.play(2, { enableAd: true, adSid: 456 }, () => completed.push(2)); await tick();
  assert.equal(requests[0].options.signal.aborted, true);
  await time.advance(31000);
  assert.deepEqual(completed, [2]); assert.equal(requests.length, 3);
  assert(requests[2].url.includes('sn=2&ad=end')); assert.equal(time.timers.size, 0);
});

test('whitespace changes to known upstream methods remain compatible and produce valid JavaScript', () => {
  const spaced = method => method.replace(/([(){},=;])/g, ' $1 ').replace(/&&/g, ' && ');
  const { output } = rewrite('bahamut-web.js', fixture(spaced(play), spaced(destroy)));
  assert.equal(typeof output.body, 'string');
  assert.doesNotThrow(() => new vm.Script(output.body));
});

test('unknown upstream logic, renamed private members and ambiguous matches leave the original response untouched', () => {
  const bodies = [
    'unrelated player', fixture().replaceAll('#d', '#unknown'), fixture(play.replace('this.#d()', 'this.#d(),this.extraWork()')),
    fixture() + fixture(), play, destroy, fixture().replace(play, '')
  ];
  for (const body of bodies) assert.deepEqual(plain(rewrite('bahamut-web.js', body).output), {});
  const first = rewrite('bahamut-web.js', fixture()).output.body;
  assert.deepEqual(plain(rewrite('bahamut-web.js', first).output), {});
});

test('player rewriting is limited to the correct resource and successful text responses', () => {
  for (const url of ['https://example.test/anime_player.js', playerURL + '.map', playerURL + '.extra', playerURL.replace('i2.', 'i3.')]) {
    assert.deepEqual(plain(rewrite('bahamut-web.js', fixture(), { url }).output), {});
  }
  for (const statusCode of [204, 206, 302, 304, 403, 500]) assert.deepEqual(plain(rewrite('bahamut-web.js', fixture(), { statusCode }).output), {});
  assert.deepEqual(plain(rewrite('bahamut-web.js', new Uint8Array([1])).output), {});
});

test('required configuration, stream and validation resources survive every repository request-reject rule in either resource order', () => {
  const resources = [
    ...['animeVideo', 'animeVideo2', 'animeLogo'].flatMap(name => ['http', 'https'].map(protocol => `${protocol}://i2.bahamut.com.tw/JS/ad/${name}.js?v=2026103019&keep=1`)),
    playerURL + '?qx_web=1', pageURL,
    'https://ani.gamer.com.tw/ajax/token.php?sn=51957',
    'https://ani.gamer.com.tw/ajax/videoCastcishu.php?s=123&sn=51957',
    'https://ani.gamer.com.tw/ajax/videoCastcishu.php?s=123&sn=51957&ad=end',
    'https://api.gamer.com.tw/anime/v1/video_src.php?videoSn=51957',
    'https://cdn.example.test/animation/51957/master.m3u8',
    'https://cdn.example.test/animation/51957/segment-1.ts'
  ];
  for (const files of [resourceFiles, [...resourceFiles].reverse()]) for (const url of resources) {
    assert.deepEqual(requestRejects(files).filter(rule => rule.regex.test(url)).map(rule => rule.file + ':' + rule.line), [], url);
  }
});

test('required player resources have no conflicting request action or competing response rewrite', () => {
  const list = resourceFiles.flatMap(rules);
  const isResponse = rule => ['script-response-body', 'jsonjq-response-body'].includes(rule.action);
  for (const url of [playerURL, pageURL, ...['animeVideo', 'animeVideo2', 'animeLogo'].map(name => `https://i2.bahamut.com.tw/JS/ad/${name}.js?v=1`)]) {
    assert.deepEqual(list.filter(rule => !isResponse(rule) && rule.regex.test(url)).map(rule => rule.file + ':' + rule.line), [], url);
    const responses = list.filter(rule => isResponse(rule) && rule.regex.test(url));
    assert.equal(responses.length, url === playerURL || url === pageURL ? 1 : 0, url);
  }
  const hosts = read('Rewrite/GeneralAdBlock/GeneralAdBlock.list').split('\n')[0].replace(/^hostname\s*=\s*/, '').split(/,\s*/);
  for (const host of ['ani.gamer.com.tw', 'i2.bahamut.com.tw', 'api.gamer.com.tw']) assert(hosts.includes(host), host);
});

test('configuration exceptions do not disable rejection of other ad-directory resources or lookalike URLs', () => {
  const rejects = requestRejects(['Advertising.list']);
  for (const url of [
    'https://i2.bahamut.com.tw/JS/ad/other.js', 'https://i2.bahamut.com.tw/JS/ad/animeVideo.js.extra',
    'https://i2.bahamut.com.tw/JS/ad/animeLogo.js/extra', 'https://i2.bahamut.com.tw.evil.test/JS/ad/animeVideo.js',
    'https://cdn.example.test/JS/ad/animeVideo.js', 'https://cdn.example.test/x/ad/video.m3u8'
  ]) assert(rejects.some(rule => rule.regex.test(url)), url);
});

test('native Foundation ICU confirms required-resource exceptions and ad rejection on macOS', {
  skip: process.platform !== 'darwin'
}, () => {
  const patterns = requestRejects(resourceFiles).map(rule => rule.source);
  const cases = [
    ...['animeVideo', 'animeVideo2', 'animeLogo'].map(name => ({ url: `https://i2.bahamut.com.tw/JS/ad/${name}.js?v=1`, reject: false })),
    { url: playerURL + '?qx_web=1', reject: false },
    { url: 'https://ani.gamer.com.tw/ajax/videoCastcishu.php?s=1&sn=1&ad=end', reject: false },
    { url: 'https://i2.bahamut.com.tw/JS/ad/other.js', reject: true },
    { url: 'https://i2.bahamut.com.tw/JS/ad/animeVideo.js.extra', reject: true },
    { url: 'https://cdn.example.test/JS/ad/animeVideo.js', reject: true }
  ];
  const source = 'ObjC.import("Foundation"); const patterns=' + JSON.stringify(patterns) + '; const cases=' + JSON.stringify(cases)
    + '; const compiled=patterns.map(pattern=>{const error=Ref();const value=$.NSRegularExpression.regularExpressionWithPatternOptionsError($(pattern),0,error);if(!value)throw Error("Invalid ICU pattern");return value});'
    + 'JSON.stringify(cases.map(item=>compiled.some(regex=>Number(regex.numberOfMatchesInStringOptionsRange($(item.url),0,$.NSMakeRange(0,item.url.length)))>0)));';
  const result = spawnSync('osascript', ['-l', 'JavaScript'], { input: source, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), cases.map(item => item.reject));
});

test('response rules match only the intended player, watch pages and native API endpoints', () => {
  const list = rules('GeneralAdBlock/GeneralAdBlock.list');
  const player = list.filter(rule => rule.value?.includes('/bahamut-web.js'));
  const html = list.filter(rule => rule.value?.includes('/web-enhance.js'));
  const native = list.filter(rule => rule.value?.includes('/bahamut-adblock.js'));
  for (const suffix of ['', '?v=1', '?v=1&other=2']) assert.equal(player.filter(rule => rule.regex.test(playerURL + suffix)).length, 1);
  for (const url of [playerURL + '.map', playerURL + '/other', playerURL.replace('/build/js/', '/other/')]) assert(!player.some(rule => rule.regex.test(url)));
  for (const page of ['', 'animeVideo.php?sn=1', 'animeList.php', 'animeRef.php?sn=1']) assert(html.some(rule => rule.regex.test('https://ani.gamer.com.tw/' + page)));
  for (const page of ['ajax/token.php?sn=1', 'ajax/videoCastcishu.php?s=1', 'animeVideo.php.extra']) assert(!html.some(rule => rule.regex.test('https://ani.gamer.com.tw/' + page)));
  for (const endpoint of ['mobile_app/anime/v1/token', 'mobile_app/anime/v1/m3u8', 'anime/v1/video_src']) assert(native.some(rule => rule.regex.test('https://api.gamer.com.tw/' + endpoint + '.php?sn=1')));
  for (const endpoint of ['anime/v1/login', 'anime/v1/video_src.php.extra', 'ajax/videoCastcishu']) assert(!native.some(rule => rule.regex.test('https://api.gamer.com.tw/' + endpoint)));
});

test('the complete player patch, rewrite script URLs and HTML asset share one cache version', () => {
  const list = rules('GeneralAdBlock/GeneralAdBlock.list');
  const patchRule = list.find(rule => rule.value?.includes('/bahamut-web.js'));
  const htmlRule = list.find(rule => rule.value?.includes('/web-enhance.js'));
  const version = new URL(patchRule.value).searchParams.get('v');
  assert(version); assert.equal(new URL(htmlRule.value).searchParams.get('v'), version);
  const body = '<html><head><script src="' + playerURL + '"></script></head></html>';
  assert(rewrite('web-enhance.js', body, { url: pageURL }).output.body.includes('qx_web=' + version));
});

test('HTML refreshes stale player versions, preserves signed parameters and fragments, and is idempotent', () => {
  const html = '<html><head><script src="' + playerURL + '?v=upstream&sig=keep&qx_web=old#fragment"></script><script src="//i2.bahamut.com.tw/build/js/anime_player.js"></script></head></html>';
  const first = rewrite('web-enhance.js', html, { url: pageURL }).output.body;
  assert(first.includes('v=upstream&sig=keep&qx_web=')); assert(first.includes('#fragment'));
  assert(!first.includes('qx_web=old')); assert.equal((first.match(/qx_web=/g) || []).length, 2);
  assert.deepEqual(plain(rewrite('web-enhance.js', first, { url: pageURL }).output), {});
});

test('HTML cache versioning does not rewrite source maps, different assets or lookalike player URLs', () => {
  const urls = [playerURL + '.map', playerURL + '.extra', playerURL.replace('i2.', 'i3.'), 'https://i2.bahamut.com.tw/js/anime.js'];
  const html = '<html><head>' + urls.map(url => '<script src="' + url + '"></script>').join('') + '</head></html>';
  const result = rewrite('web-enhance.js', html, { url: pageURL }).output.body;
  for (const url of urls) assert(result.includes('src="' + url + '"'), url);
  assert(!result.includes('qx_web='));
});

test('Safari token and video-source responses retain authentication, entitlements and region errors', () => {
  for (const payload of [
    { data: { src: 'https://cdn.example.test/main.m3u8?sig=keep', token: 'fixture-only' }, ad: { major: ['keep'], minor: ['keep'] } },
    { error: 'region restricted' }, { error: 'VIP membership required' }, { error: 'login required' }, { error: 'age restriction' }
  ]) {
    const body = JSON.stringify(payload);
    const result = rewrite('bahamut-adblock.js', body, {
      url: 'https://api.gamer.com.tw/anime/v1/video_src.php?videoSn=51957',
      requestHeaders: { Referer: pageURL, 'User-Agent': 'Mozilla/5.0 Mobile Safari/605.1' }
    });
    assert.deepEqual(plain(result.output), {}); assert.equal(result.requests.length, 0);
    assert.deepEqual(plain(rewrite('web-enhance.js', body, { url: 'https://ani.gamer.com.tw/ajax/token.php?sn=51957' }).output), {});
  }
});

test('current official player and watch-page resources accept the local patch without executing remote JavaScript', {
  skip: process.env.QX_BAHAMUT_LIVE !== '1', timeout: 45000
}, async t => {
  const ca = [...tls.rootCertificates];
  if (process.env.QX_BAHAMUT_CA) ca.push(new crypto.X509Certificate(fs.readFileSync(process.env.QX_BAHAMUT_CA)).toString());
  function get(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, { ca }, response => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.setTimeout(15000, () => request.destroy(Error('Resource request timed out')));
      request.on('error', reject);
    });
  }
  // Encoding one filename character bypasses the active QX rewrite, keeping TLS
  // verification and the existing tunnel intact. No login or validation is sent.
  const upstreamPlayer = await get(playerURL.replace('/anime_', '/%61nime_'));
  assert.equal(upstreamPlayer.status, 200);
  assert(!upstreamPlayer.body.includes('qxWebAdValidation'), 'Expected the unmodified upstream resource');
  const patched = rewrite('bahamut-web.js', upstreamPlayer.body).output.body;
  assert.equal(typeof patched, 'string', 'Current official methods should match');
  const syntax = spawnSync(process.execPath, ['--check'], { input: patched, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const upstreamPage = await get(pageURL.replace('/animeVideo', '/%61nimeVideo'));
  assert.equal(upstreamPage.status, 200);
  const page = rewrite('web-enhance.js', upstreamPage.body, { url: pageURL }).output.body;
  const version = new URL(rules('GeneralAdBlock/GeneralAdBlock.list').find(rule => rule.value?.includes('/bahamut-web.js')).value).searchParams.get('v');
  assert(page.includes('qx_web=' + version));
  const rejects = requestRejects(resourceFiles);
  for (const name of ['animeVideo', 'animeVideo2', 'animeLogo']) {
    const url = `https://i2.bahamut.com.tw/JS/ad/${name}.js`;
    assert(upstreamPage.body.includes('/JS/ad/' + name + '.js'), name);
    assert(!rejects.some(rule => rule.regex.test(url)));
    assert.equal((await get(url)).status, 200);
  }
  t.diagnostic(JSON.stringify({ playerBytes: Buffer.byteLength(upstreamPlayer.body), playerSHA256: crypto.createHash('sha256').update(upstreamPlayer.body).digest('hex'), patchedBytes: Buffer.byteLength(patched), requiredConfigScripts: 3, cacheVersion: version }));
});
