/**
 * Bahamut Anime ad bypass for Quantumult X.
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
    const value = $prefs.valueForKey(PREWARM_KEY);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.log(`[BahamutAnimeAds] Invalid prewarm state: ${error.message || error}`);
    return null;
  }
}

function writePrewarmState(state) {
  $prefs.setValueForKey(JSON.stringify(state), PREWARM_KEY);
}

function clearPrewarmState(videoSn) {
  const state = readPrewarmState();
  if (!videoSn || !state || state.videoSn === videoSn) {
    $prefs.removeValueForKey(PREWARM_KEY);
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
  return $task.fetch({ url, method: "GET", headers }).then((response) => response.body || "");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
