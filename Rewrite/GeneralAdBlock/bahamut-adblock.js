/* Bahamut native QX ad filtering, v1.2.0. */
(() => {
  const WAIT_MS = 25000;
  const TTL_MS = 120000;
  const START_BUDGET_MS = 750;
  const STATE_KEY = 'bahamut_ad_prewarm_v2';
  const url = $request.url || '';
  const endpoint = /^https:\/\/api\.gamer\.com\.tw\/(?:mobile_app\/anime\/v\d+\/(token|m3u8)|anime\/v\d+\/(video_src))\.php(?:\?|$)/.exec(url);
  if (!endpoint || !$response || $response.statusCode >= 400) return $done({});
  const headers = Object.fromEntries(Object.entries($request.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const browser = /^https:\/\/ani\.gamer\.com\.tw(?:\/|$)/i.test(headers.origin || headers.referer || '')
    || /Macintosh/.test(headers['user-agent'] || '') && /Safari\//.test(headers['user-agent'] || '');
  if (browser && endpoint[2]) return $done({});
  const serial = /[?&](?:videoSn|sn)=(\d+)(?:&|$)/i.exec(url)?.[1] || '';
  let payload;
  try { payload = JSON.parse($response.body || ''); }
  catch (_) { return $done({}); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return $done({});
  let finished = false;
  const done = value => { if (!finished) { finished = true; $done(value); } };
  run().catch(error => {
    console.log(`[Bahamut] ${error.message || 'Request failed'}`);
    done({});
  });

  async function run() {
    if (endpoint[1] === 'token') {
      let changed = false;
      for (const ad of [payload.ad, payload.data?.ad]) {
        if (!ad || typeof ad !== 'object') continue;
        for (const name of ['major', 'minor']) if (Array.isArray(ad[name]) && ad[name].length) {
          ad[name] = [];
          changed = true;
        }
      }
      if (!changed) return done({});
      if (serial) {
        try { await startValidation(); }
        catch (_) { /* Ad removal must not depend on prewarming succeeding. */ }
      }
      return done({ body: JSON.stringify(payload) });
    }
    if (!serial || !needsValidation(payload)) return done({});
    let state = readState();
    if (!state || state.status !== 'pending') {
      const started = await startValidation();
      if (!started) return done({});
      state = readState();
    }
    if (!state || state.status !== 'pending') return done({});
    const remaining = Math.max(0, WAIT_MS - (Date.now() - state.startedAt));
    if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
    await fetchText(progressURL('end'));
    const current = readState();
    if (current?.startedAt === state.startedAt) $prefs.removeValueForKey(STATE_KEY);
    const response = await fetchText(url);
    let retried;
    try { retried = JSON.parse(response); }
    catch (_) { return done({}); }
    if (!retried || typeof retried !== 'object' || Array.isArray(retried)) return done({});
    done({ body: JSON.stringify(retried) });
  }

  async function startValidation() {
    let state = readState();
    if (state?.status === 'starting') {
      const deadline = Date.now() + START_BUDGET_MS;
      while (state?.status === 'starting' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
        state = readState();
      }
      return state?.status === 'pending';
    }
    if (state) return state.status === 'pending';
    const startedAt = Date.now();
    $prefs.setValueForKey(JSON.stringify({ videoSn: serial, startedAt, status: 'starting' }), STATE_KEY);
    let timer;
    const ready = await Promise.race([
      fetchText(progressURL('')).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), START_BUDGET_MS); })
    ]);
    clearTimeout(timer);
    const current = readState();
    if (current?.startedAt !== startedAt || current.status !== 'starting') return false;
    if (!ready) {
      $prefs.removeValueForKey(STATE_KEY);
      return false;
    }
    $prefs.setValueForKey(JSON.stringify({ videoSn: serial, startedAt: Date.now(), status: 'pending' }), STATE_KEY);
    return true;
  }

  function readState() {
    try {
      const state = JSON.parse($prefs.valueForKey(STATE_KEY) || 'null');
      const age = Date.now() - state?.startedAt;
      return state?.videoSn === serial && Number.isFinite(age) && age >= 0 && age < (state.status === 'starting' ? START_BUDGET_MS * 2 : TTL_MS) ? state : null;
    } catch (_) { return null; }
  }

  function needsValidation(value) {
    if (!(value.error || value.message)) return false;
    const text = JSON.stringify([value.error, value.message]);
    if (/vip|premium|member|付費|付费|會員|会员|登入|登录|login|region|地區|地区|年齡|年龄|age.?restrict/i.test(text)) return false;
    if (!value.error && /^(?:success|ok|成功)$/i.test(String(value.message))) return false;
    for (const source of [value, value.data]) {
      if (!source || typeof source !== 'object') continue;
      for (const key of ['src', 'url']) if (typeof source[key] === 'string' && /^https?:/.test(source[key])) return false;
    }
    return true;
  }

  function progressURL(stage) {
    return 'https://api.gamer.com.tw/mobile_app/anime/v1/stat_ad.php?ad=' + stage + '&schedule=0&sn=' + serial;
  }

  async function fetchText(target) {
    const cleanHeaders = Object.fromEntries(Object.entries($request.headers || {}).filter(([key]) =>
      !/^(?:host|content-length|content-encoding|connection|transfer-encoding)$/i.test(key)));
    const result = await $task.fetch({ url: target, method: 'GET', headers: cleanHeaders, opts: { redirection: false } });
    if (result.statusCode < 200 || result.statusCode >= 300) throw Error('HTTP ' + result.statusCode);
    return result.body || '';
  }
})();
