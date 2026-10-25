((qxDone, qxRequest, qxResponse, qxEnvironment) => {
  const browserHeaders = Object.fromEntries(Object.entries(qxRequest.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  const browserRequest = /^https:\/\/ani\.gamer\.com\.tw(?:\/|$)/i.test(browserHeaders.origin || browserHeaders.referer || "")
    || /Macintosh/.test(browserHeaders["user-agent"] || "") && /Safari\//.test(browserHeaders["user-agent"] || "");
  if (browserRequest && /^https:\/\/api\.gamer\.com\.tw\/anime\/v\d\/video_src\.php(?:\?|$)/.test(qxRequest.url || "")) return qxDone({});
  const bytes = value => value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  const store = {
    read: key => $prefs.valueForKey(key),
    write: (value, key) => value == null || value === "" ? $prefs.removeValueForKey(key) : $prefs.setValueForKey(String(value), key)
  };
  const prefs = {
    valueForKey: key => store.read(key),
    setValueForKey: (value, key) => store.write(value, key),
    removeValueForKey: key => $prefs.removeValueForKey(key)
  };
  const request = { ...qxRequest };
  const response = qxResponse ? { ...qxResponse, status: qxResponse.statusCode } : undefined;
  let responsePatched = false;
  if (false && response) {
    const originalBody = qxResponse.body;
    Object.defineProperty(response, "body", {
      configurable: true, enumerable: true,
      get: () => bytes(response.bodyBytes) || originalBody,
      set(value) {
        const body = bytes(value);
        response.bodyBytes = body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : undefined;
        responsePatched = !!body;
      }
    });
  }
  if (false && request.bodyBytes) request.body = bytes(request.bodyBytes);
  let completed = false;
  const done = value => {
    if (completed) return;
    completed = true;
    if (typeof value === "string") return qxDone(value);
    const output = { ...(value?.response || value || {}) };
    if (typeof output.status === "number") {
      const reason = { 200: "OK", 302: "Found", 400: "Bad Request", 403: "Forbidden", 429: "Too Many Requests", 503: "Service Unavailable" }[output.status] || "";
      output.status = "HTTP/1.1 " + output.status + (reason ? " " + reason : "");
    }
    if (responsePatched && output.body === undefined && output.bodyBytes === undefined) output.bodyBytes = response.bodyBytes;
    const body = bytes(output.body);
    if (body) {
      output.bodyBytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      delete output.body;
    }
    const bodyBytes = bytes(output.bodyBytes);
    if (bodyBytes) output.bodyBytes = bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength);
    if (response && output.headers && output.body === undefined && output.bodyBytes === undefined) {
      if (false && bytes(qxResponse.bodyBytes)) output.bodyBytes = qxResponse.bodyBytes;
      else if (typeof qxResponse.body === "string") output.body = qxResponse.body;
    }
    qxDone(output);
  };
  const send = (method, input, callback) => {
    const spec = typeof input === "string" ? { url: input } : { ...input };
    spec.method = method;
    if (/^https:\/\/(?:youtube-(?:caption|lyrics)-translate\.hmtw47cv7m\.workers\.dev|translate\.googleapis\.com|translate\.google\.com)(?:\/|$)/.test(spec.url)) {
      spec.opts = { ...spec.opts, policy: "direct" };
    }
    $task.fetch(spec).then(
      result => callback(null, { ...result, status: result.statusCode }, result.body),
      error => callback(error?.error || error?.message || String(error))
    );
  };
  const http = { get: (input, callback) => send("GET", input, callback), post: (input, callback) => send("POST", input, callback) };
  const options = {};
  try {
    const fragment = String(qxEnvironment?.sourcePath || "").split("#").slice(1).join("#");
    if (fragment) {
      for (const field of fragment.split("&")) {
        const position = field.indexOf("=");
        if (position < 0) continue;
        const key = decodeURIComponent(field.slice(0, position));
        const value = decodeURIComponent(field.slice(position + 1));
        if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
        try { options[key] = JSON.parse(value); } catch (_) { options[key] = value; }
      }
    }
  } catch (_) {}
  const argument = options;

  (($request, $response, $done, $persistentStore, $prefs, $httpClient, $argument, $utils) => {
/**
 * Bahamut Anime ad bypass for Surge.
 *
 * Bahamut validates the ad viewing interval server-side. Start that interval
 * on the detail-page token request so it can finish before playback begins.
 * The playback-source handler retains the original wait-and-retry fallback.
 * Supports both the legacy m3u8.php endpoint and the current video_src.php.
 */

const AD_WAIT_MS = 25000;
const PREWARM_TTL_MS = 120000;
const PREWARM_STALE_MS = AD_WAIT_MS + 10000;
const PREWARM_KEY = "bahamut_ad_prewarm_v1";
const requestURL = $request.url || "";
let responseJSON;

try {
  responseJSON = JSON.parse($response.body || "{}");
} catch (error) {
  console.log(`[BahamutAnimeAds] Invalid JSON response: ${error.message || error}`);
  $done({});
}

if (responseJSON) {
  run()
    .then(() => $done({ body: JSON.stringify(responseJSON) }))
    .catch((error) => {
      console.log(`[BahamutAnimeAds] ${error.message || error}`);
      $done({});
    });
}

async function run() {
  if (requestURL.includes("/token.php")) {
    clearAdSlots(responseJSON);

    const videoSn = getVideoSn(requestURL);
    if (videoSn) {
      try {
        await prewarmAdValidation(videoSn);
      } catch (error) {
        clearPrewarmState(videoSn);
        console.log(`[BahamutAnimeAds] Prewarm failed: ${error.message || error}`);
      }
    }

    return;
  }

  if (!isPlaybackSource(requestURL)) {
    return;
  }

  const videoSn = getVideoSn(requestURL);
  if (!videoSn) {
    throw new Error("Missing video serial number");
  }

  if (!hasPlaybackError(responseJSON)) {
    clearPrewarmState(videoSn);
    return;
  }

  clearPrewarmState(videoSn);
  await completeAdValidation(videoSn);

  const retriedResponse = await fetchJSON(requestURL, $request.headers || {});
  if (retriedResponse) {
    responseJSON = retriedResponse;
  }

  clearPrewarmState(videoSn);
}

async function prewarmAdValidation(videoSn) {
  const state = readPrewarmState();
  const now = Date.now();

  if (
    state &&
    state.videoSn === videoSn &&
    state.status === "complete" &&
    now - state.completedAt < PREWARM_TTL_MS
  ) {
    console.log(`[BahamutAnimeAds] Prewarm ready for ${videoSn}`);
    return;
  }

  if (
    state &&
    state.videoSn === videoSn &&
    state.status === "pending" &&
    now - state.startedAt < PREWARM_STALE_MS
  ) {
    const remaining = Math.max(0, AD_WAIT_MS - (now - state.startedAt));
    await sleep(remaining + 500);

    const refreshedState = readPrewarmState();
    if (
      refreshedState &&
      refreshedState.videoSn === videoSn &&
      refreshedState.status === "complete"
    ) {
      return;
    }

    await reportAdProgress("end", videoSn);
    writePrewarmState({
      videoSn,
      status: "complete",
      completedAt: Date.now()
    });
    return;
  }

  await reportAdProgress("", videoSn);
  writePrewarmState({
    videoSn,
    status: "pending",
    startedAt: Date.now()
  });
  await sleep(AD_WAIT_MS);
  await reportAdProgress("end", videoSn);
  writePrewarmState({
    videoSn,
    status: "complete",
    completedAt: Date.now()
  });
}

async function completeAdValidation(videoSn) {
  await reportAdProgress("", videoSn);
  await sleep(AD_WAIT_MS);
  await reportAdProgress("end", videoSn);
}

function clearAdSlots(body) {
  if (body.ad) {
    body.ad.minor = [];
    body.ad.major = [];
  }

  if (body.data && body.data.ad) {
    body.data.ad.minor = [];
    body.data.ad.major = [];
  }
}

function isPlaybackSource(url) {
  return url.includes("/m3u8.php") || url.includes("/video_src.php");
}

function hasPlaybackError(body) {
  return Boolean(body && (body.error || body.message));
}

function getVideoSn(url) {
  const match = url.match(/[?&](?:videoSn|sn)=(\d+)/i);
  return match ? match[1] : "";
}

function readPrewarmState() {
  try {
    const value = $persistentStore.read(PREWARM_KEY);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.log(`[BahamutAnimeAds] Invalid prewarm state: ${error.message || error}`);
    return null;
  }
}

function writePrewarmState(state) {
  $persistentStore.write(JSON.stringify(state), PREWARM_KEY);
}

function clearPrewarmState(videoSn) {
  const state = readPrewarmState();
  if (!videoSn || !state || state.videoSn === videoSn) {
    $persistentStore.write(null, PREWARM_KEY);
  }
}

function reportAdProgress(stage, videoSn) {
  const url =
    "https://api.gamer.com.tw/mobile_app/anime/v1/stat_ad.php" +
    `?ad=${encodeURIComponent(stage)}&schedule=0&sn=${encodeURIComponent(videoSn)}`;

  return fetchText(url, $request.headers || {}).then(() => undefined);
}

function fetchJSON(url, headers) {
  return fetchText(url, headers).then((body) => {
    try {
      return JSON.parse(body || "{}");
    } catch (error) {
      throw new Error(`Invalid retry response: ${error.message || error}`);
    }
  });
}

function fetchText(url, headers) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, headers }, (error, response, body) => {
      if (error) {
        reject(new Error(String(error)));
        return;
      }

      resolve(body || "");
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
