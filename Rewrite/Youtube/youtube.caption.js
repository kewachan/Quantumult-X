((qxDone, qxRequest, qxResponse, qxEnvironment) => {
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
  const options = {"captionLang":"zh-Hant","blockUpload":true,"blockImmersive":true,"blockShorts":false,"lyricsLang":"zh-Hant","captionToken":"","lyricsToken":"","debug":false};
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
// Fetch source captions without YouTube's restricted native translation parameter.
// Google Translate POST batches and a persistent Worker queue supply the translations.

const TRANSLATE_ENDPOINTS = ["https://translate.googleapis.com/translate_a/t", "https://translate.google.com/translate_a/t"];
const CAPTION_WORKER_ENDPOINT = "https://youtube-caption-translate.hmtw47cv7m.workers.dev/caption/jobs";
const MAX_QUERY_CHARS = 1700;
const MAX_BATCH_ITEMS = 60;
const CONCURRENCY = 4;
const RESPONSE_BUDGET_MS = 4500;
const TRANSLATE_TIMEOUT_SECONDS = 4;
const MIN_RETRY_WINDOW_MS = 1200;
const SCRIPT_RESPONSE_BUDGET_MS = 6500;
const SOURCE_CAPTION_TIMEOUT_SECONDS = 3;
const QUEUE_SUBMIT_TIMEOUT_SECONDS = 5;
const QUEUE_POLL_TIMEOUT_SECONDS = 2;
const QUEUE_DEFAULT_POLL_MS = 500;
const DIRECT_FALLBACK_MAX_BATCHES = 32;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 96;
const CACHE_INDEX_KEY = "YouTubeCaption.CacheIndex.v6";
const JOB_CACHE_PREFIX = "YouTubeCaption.Job.v20.";

function scriptOptions() {
  const defaults = {captionToken: "", debug: false};
  try {
    if (typeof $argument === "string" && !$argument.includes("{{{")) {
      return {...defaults, ...JSON.parse($argument)};
    }
    if (typeof $argument === "object" && $argument) return {...defaults, ...$argument};
  } catch (_) {}
  return defaults;
}

function validCaptionToken(value) {
  const token = String(value || "").trim();
  return token.length >= 32 && token.length <= 128 && !/\s/.test(token) && token !== "paste-token-here";
}

function debugLog(options, message) {
  if (options.debug) console.log(`YouTube caption: ${message}`);
}

function getQueryValue(url, name) {
  const match = url.match(new RegExp(`[?&]${name}=([^&#]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function mapTargetLanguage(language) {
  const normalized = language.toLowerCase();
  return {"zh-hant": "zh-TW", "zh-tw": "zh-TW", "zh-hans": "zh-CN", "zh-cn": "zh-CN"}[normalized] || language;
}

function cacheKey(query, source, target) {
  let hash = 2166136261;
  const value = `${source}|${target}|${query}`;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `YouTubeCaption.v6.${(hash >>> 0).toString(16)}`;
}

function captionJobCacheKey(entries, source, target) {
  let primary = 2166136261;
  let secondary = 2246822519;
  const values = [source, target, ...entries.map((entry) => entry.text)];
  for (const value of values) {
    const text = `${String(value).length}:${value}|`;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      primary = Math.imul(primary ^ code, 16777619);
      secondary = Math.imul(secondary ^ code, 3266489917);
    }
  }
  return `${JOB_CACHE_PREFIX}${(primary >>> 0).toString(16)}${(secondary >>> 0).toString(16)}`;
}

function readCaptionJob(key, itemCount) {
  try {
    const saved = JSON.parse($persistentStore.read(key) || "null");
    if (saved && /^[0-9a-f-]{36}$/i.test(String(saved.jobId || ""))
      && saved.itemCount === itemCount && Date.now() - Number(saved.savedAt || 0) < CACHE_TTL_MS) {
      return saved.jobId;
    }
    if (saved) $persistentStore.write("", key);
  } catch (_) {
    try { $persistentStore.write("", key); } catch (_) {}
  }
  return "";
}

function writeCaptionJob(key, jobId, itemCount) {
  try {
    $persistentStore.write(JSON.stringify({jobId, itemCount, savedAt: Date.now()}), key);
  } catch (_) {}
}

function clearCaptionJob(key) {
  try { $persistentStore.write("", key); } catch (_) {}
}

function readCachedParts(key, length) {
  try {
    const cached = JSON.parse($persistentStore.read(key) || "null");
    const fresh = cached && Array.isArray(cached.parts)
      && cached.parts.length === length
      && Date.now() - Number(cached.savedAt || 0) < CACHE_TTL_MS;
    if (fresh) return cached.parts;
    if (cached) $persistentStore.write("", key);
  } catch (_) {
    try { $persistentStore.write("", key); } catch (_) {}
  }
  return null;
}

function writeCachedParts(key, parts) {
  try {
    const savedAt = Date.now();
    $persistentStore.write(JSON.stringify({savedAt, parts}), key);
    const storedIndex = JSON.parse($persistentStore.read(CACHE_INDEX_KEY) || "[]");
    const index = (Array.isArray(storedIndex) ? storedIndex : [])
      .filter((item) => item?.key && item.key !== key && savedAt - Number(item.savedAt || 0) < CACHE_TTL_MS);
    index.push({key, savedAt});
    while (index.length > CACHE_LIMIT) {
      const expired = index.shift();
      if (expired?.key) $persistentStore.write("", expired.key);
    }
    $persistentStore.write(JSON.stringify(index), CACHE_INDEX_KEY);
  } catch (_) {}
}

function rewriteCaptionRequest(url) {
  const target = getQueryValue(url, "tlang") || getQueryValue(url, "enhance_tlang");
  if (!target) return url;
  const googleTarget = mapTargetLanguage(target);
  const queryStart = url.indexOf("?");
  const fragmentStart = url.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? url.length : fragmentStart;
  let targetWritten = false;
  const query = url.slice(queryStart + 1, queryEnd).split("&").filter((part) => {
    if (!/^(?:enhance_)?tlang=/.test(part)) return true;
    if (targetWritten) return false;
    targetWritten = true;
    return true;
  }).map((part) => /^(?:enhance_)?tlang=/.test(part)
    ? `enhance_tlang=${encodeURIComponent(googleTarget)}`
    : part);
  return `${url.slice(0, queryStart + 1)}${query.join("&")}${url.slice(queryEnd)}`;
}

function fetchSourceCaptions(url, responseDeadline) {
  return new Promise((resolve, reject) => {
    const remaining = responseDeadline - Date.now();
    if (remaining < 500) return reject(new Error("Source caption retry budget exhausted"));
    const seconds = Math.max(1, Math.min(SOURCE_CAPTION_TIMEOUT_SECONDS, Math.floor(remaining / 1000)));
    $httpClient.get({
      url: rewriteCaptionRequest(url),
      timeout: typeof $loon !== "undefined" ? seconds * 1000 : seconds,
      headers: {...($request.headers || {}), Accept: "text/xml, */*"},
    }, (error, response, body) => {
      if (error) return reject(error);
      const status = response?.status || response?.statusCode;
      if (status !== 200 || !/<timedtext\b/.test(body || "") || !/<p(?:\s|>)/.test(body || "")) {
        return reject(new Error(`Source caption response unavailable (${status || "unknown"})`));
      }
      resolve({body, headers: response.headers});
    });
  });
}

function decodeXml(text) {
  return text
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function encodeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function rewrittenResponseHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase();
    if (normalized === "content-type" || normalized === "content-encoding"
      || normalized === "content-length" || normalized === "transfer-encoding") continue;
    output[name] = value;
  }
  output["Content-Type"] = "text/xml; charset=utf-8";
  return output;
}

function separator(index) {
  return "\n";
}

function buildBatches(captions, missingOnly = false) {
  const batches = [];
  let items = [];
  let query = "";
  captions.forEach((caption, index) => {
    if (missingOnly && caption.translated) return;
    const addition = `${items.length ? separator(index) : ""}${caption.text}`;
    if (items.length && (items.length >= MAX_BATCH_ITEMS || (query + addition).length > MAX_QUERY_CHARS)) {
      batches.push({items, query});
      items = [];
      query = "";
    }
    query += `${items.length ? separator(index) : ""}${caption.text}`;
    items.push({captionIndex: index});
  });
  if (items.length) batches.push({items, query});
  return batches;
}

function applyCachedTranslations(captions, source, target) {
  for (const batch of buildBatches(captions)) {
    const parts = readCachedParts(cacheKey(batch.query, source, target), batch.items.length);
    if (!parts) continue;
    batch.items.forEach((item, index) => { captions[item.captionIndex].translated = parts[index].trim(); });
  }
}

function writeResolvedCaches(captions, source, target) {
  for (const batch of buildBatches(captions)) {
    const parts = batch.items.map((item) => String(captions[item.captionIndex].translated || "").trim());
    if (parts.every(Boolean)) writeCachedParts(cacheKey(batch.query, source, target), parts);
  }
}

function captionWorkerRequest(method, url, token, body, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const request = {
      url,
      timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
      headers: {Accept: "application/json"},
    };
    if (validCaptionToken(token)) request.headers.Authorization = `Bearer ${token.trim()}`;
    if (body !== undefined) {
      request.headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(body);
    }
    const callback = (error, response, responseBody) => {
      if (error) return reject(error);
      try {
        const status = response.status || response.statusCode;
        if (status < 200 || status >= 300) {
          const requestError = new Error(`Caption Worker status ${status}`);
          requestError.status = status;
          throw requestError;
        }
        const parsed = responseBody ? JSON.parse(responseBody) : {};
        resolve(parsed);
      } catch (parseError) {
        reject(parseError);
      }
    };
    if (method === "POST") $httpClient.post(request, callback);
    else $httpClient.get(request, callback);
  });
}

async function translateWithQueue(entries, source, target, token, options) {
  const payload = {
    purpose: "captions",
    source,
    target,
    texts: entries.map((entry) => entry.text),
  };
  const responseDeadline = Number(options.responseDeadline) || Date.now() + SCRIPT_RESPONSE_BUDGET_MS;
  const jobKey = captionJobCacheKey(entries, source, target);
  let queueToken = validCaptionToken(token) ? token.trim() : "";
  let jobId = readCaptionJob(jobKey, entries.length);
  let submitted = false;
  let pollMs = jobId ? 0 : QUEUE_DEFAULT_POLL_MS;

  async function submitJob() {
    if (responseDeadline - Date.now() < 500) throw new Error("Caption Worker submit budget exhausted");
    let created;
    const timeout = Math.max(
      1,
      Math.min(QUEUE_SUBMIT_TIMEOUT_SECONDS, Math.ceil((responseDeadline - Date.now()) / 1000)),
    );
    try {
      created = await captionWorkerRequest("POST", CAPTION_WORKER_ENDPOINT, queueToken, payload, timeout);
    } catch (error) {
      if (error?.status !== 401 || !queueToken) throw error;
      queueToken = "";
      created = await captionWorkerRequest("POST", CAPTION_WORKER_ENDPOINT, queueToken, payload, timeout);
    }
    if (!/^[0-9a-f-]{36}$/i.test(String(created?.jobId || ""))) {
      throw new Error("Invalid Caption Worker job response");
    }
    jobId = created.jobId;
    submitted = true;
    pollMs = Math.max(250, Math.min(2000, Number(created.pollAfterMs) || QUEUE_DEFAULT_POLL_MS));
    writeCaptionJob(jobKey, jobId, entries.length);
  }

  if (!jobId) await submitJob();
  let latest = null;
  while (Date.now() < responseDeadline && !options.stopWhenComplete?.()) {
    const remainingBeforeWait = responseDeadline - Date.now();
    if (pollMs > 0) {
      if (remainingBeforeWait <= pollMs) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const remaining = responseDeadline - Date.now();
    if (remaining < 250) break;
    try {
      latest = await captionWorkerRequest(
        "GET",
        `${CAPTION_WORKER_ENDPOINT}/${jobId}`,
        queueToken,
        undefined,
        Math.max(1, Math.min(QUEUE_POLL_TIMEOUT_SECONDS, Math.ceil(remaining / 1000))),
      );
    } catch (error) {
      if (error?.status === 401 && queueToken) {
        queueToken = "";
        continue;
      }
      if (error?.status === 404 && !submitted) {
        clearCaptionJob(jobKey);
        jobId = "";
        await submitJob();
        continue;
      }
      if (error?.status >= 400 && error.status < 500) throw error;
      debugLog(options, `queue poll retry: ${error}`);
      pollMs = QUEUE_DEFAULT_POLL_MS;
      continue;
    }
    if (!Array.isArray(latest?.translations) || latest.translations.length !== entries.length) {
      throw new Error("Invalid Caption Worker status response");
    }
    debugLog(options, `queue ${latest.status} ${latest.completedBatches || 0}/${latest.batchCount || 0}`);
    if (latest.status === "complete") return latest;
    if (latest.status === "failed") {
      clearCaptionJob(jobKey);
      return latest;
    }
    pollMs = Math.max(250, pollMs || QUEUE_DEFAULT_POLL_MS);
  }
  return latest;
}

function applyQueuedTranslations(entries, result, captions) {
  if (!Array.isArray(result?.translations)) return 0;
  let applied = 0;
  result.translations.forEach((translation, index) => {
    const text = String(translation || "").trim();
    const entry = entries[index];
    if (!text || !entry) return;
    captions[entry.captionIndex].translated = text;
    applied++;
  });
  return applied;
}

function requestTranslation(endpoint, query, source, target, timeoutSeconds) {
  const language = source === "auto" ? source : source.split("-")[0];
  const url = `${endpoint}?client=dict-chrome-ex&sl=${encodeURIComponent(language)}&tl=${encodeURIComponent(target)}`;
  const body = `client=dict-chrome-ex&sl=${encodeURIComponent(language)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(query)}`;
  return new Promise((resolve, reject) => {
    $httpClient.post({
      url,
      timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
      headers: {Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
      body,
    }, (error, response, body) => {
      if (error) return reject(error);
      try {
        const status = response.status || response.statusCode;
        if (status !== 200) throw new Error(`Google Translate status ${status}`);
        const result = JSON.parse(body);
        const translated = typeof result?.[0] === "string" ? result[0]
          : Array.isArray(result?.[0]) && typeof result[0][0] === "string" ? result[0][0] : "";
        if (!translated.trim()) throw new Error("Empty Google Translate response");
        resolve(translated);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function fetchTranslation(query, source, target, deadline) {
  let lastError;
  for (let attempt = 0; attempt < TRANSLATE_ENDPOINTS.length; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError || new Error("Caption translation time budget exhausted");
    try {
      const timeout = Math.max(1, Math.min(TRANSLATE_TIMEOUT_SECONDS, Math.ceil(remaining / 1000)));
      return await requestTranslation(TRANSLATE_ENDPOINTS[attempt], query, source, target, timeout);
    } catch (error) {
      lastError = error;
      if (attempt === TRANSLATE_ENDPOINTS.length - 1) break;
      const delay = 200;
      if (Date.now() + delay + MIN_RETRY_WINDOW_MS >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error("Caption translation failed");
}

function rebuildBatch(items, captions) {
  return {
    items,
    query: items.map((item, index) => `${index ? separator(item.captionIndex) : ""}${captions[item.captionIndex].text}`).join(""),
  };
}

async function translateBatches(batches, captions, source, target, responseDeadline, onProgress = () => {}) {
  const queue = [...batches];
  const available = Math.max(0, Number(responseDeadline || Infinity) - Date.now());
  const budget = Math.min(RESPONSE_BUDGET_MS, available);
  if (budget < 250) return;
  const deadline = Date.now() + budget;
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length && Date.now() < deadline) {
      let batch = queue[cursor++];
      const missing = batch.items.filter((item) => !captions[item.captionIndex].translated);
      if (!missing.length) continue;
      if (missing.length !== batch.items.length) batch = rebuildBatch(missing, captions);
      try {
        const key = cacheKey(batch.query, source, target);
        let parts = readCachedParts(key, batch.items.length);
        if (!parts) {
          const translated = await fetchTranslation(batch.query, source, target, deadline);
          parts = translated.split(/\r?\n/).map((part) => part.trim());
          if (parts.length === batch.items.length && parts.every(Boolean)) writeCachedParts(key, parts);
        }
        if (parts.length !== batch.items.length || !parts.every((part) => part.trim())) {
          if (batch.items.length > 1) {
            const middle = Math.ceil(batch.items.length / 2);
            queue.push(rebuildBatch(batch.items.slice(0, middle), captions));
            queue.push(rebuildBatch(batch.items.slice(middle), captions));
          }
          continue;
        }
        batch.items.forEach((item, index) => { captions[item.captionIndex].translated = parts[index].trim(); });
        onProgress();
      } catch (error) {
        console.log(`Google caption batch failed: ${error}`);
      }
    }
  }
  const work = Promise.all(Array.from({length: Math.min(CONCURRENCY, queue.length)}, worker));
  let timer;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, budget); })]);
  if (timer) clearTimeout(timer);
}

async function translateCaptionResponse() {
  const options = scriptOptions();
  const responseDeadline = Date.now() + SCRIPT_RESPONSE_BUDGET_MS;
  const legacyTarget = getQueryValue($request.url, "enhance_tlang");
  const nativeTarget = getQueryValue($request.url, "tlang");
  const target = mapTargetLanguage(legacyTarget || nativeTarget);
  const source = getQueryValue($request.url, "lang") || "auto";
  if (!target) return $done({});
  if (!legacyTarget && (/<timedtext\b/.test($response.body || "") || /^\s*\{\s*"events"\s*:/.test($response.body || ""))
    && Number($response.status || 200) === 200) {
    return $done({});
  }
  let body = $response.body || "";
  let responseHeaders = $response.headers;
  if (!/<timedtext\b/.test(body) || Number($response.status || 200) >= 400) {
    const original = await fetchSourceCaptions($request.url, responseDeadline);
    body = original.body;
    responseHeaders = original.headers || responseHeaders;
  }
  const captions = [];
  const paragraph = /<p(\s[^>]*)?>([\s\S]*?)<\/p>/g;
  const segment = /<s(?:\s[^>]*)?>([\s\S]*?)<\/s>/g;
  let match;
  while ((match = paragraph.exec(body))) {
    const pieces = [];
    let part;
    segment.lastIndex = 0;
    while ((part = segment.exec(match[2]))) pieces.push(part[1]);
    // srv3 may contain either word-level <s> nodes or plain text directly
    // inside each timed <p> node.
    const rawText = pieces.length ? pieces.join("") : match[2].replace(/<[^>]*>/g, "");
    const text = decodeXml(rawText).replace(/\s+/g, " ").trim();
    if (text) captions.push({start: match.index, end: paragraph.lastIndex, attributes: match[1] || "", text});
  }
  if (!captions.length) return $done({});

  applyCachedTranslations(captions, source, target);
  const entries = captions.map((caption, captionIndex) => ({captionIndex, text: caption.text}));
  const allTranslated = () => captions.every((caption) => caption.translated);
  if (!allTranslated()) {
    let resolveComplete;
    const complete = new Promise((resolve) => { resolveComplete = resolve; });
    const onProgress = () => { if (allTranslated()) resolveComplete(); };
    const queueWork = (async () => {
      try {
        const queued = await translateWithQueue(entries, source, target, options.captionToken,
          {...options, responseDeadline, stopWhenComplete: allTranslated});
        applyQueuedTranslations(entries, queued, captions);
        writeResolvedCaches(captions, source, target);
        onProgress();
      } catch (error) { console.log(`Caption Worker queue failed: ${error}`); }
    })();
    const directWork = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (allTranslated()) return;
      const batches = buildBatches(captions, true);
      if (batches.length > DIRECT_FALLBACK_MAX_BATCHES) return;
      await translateBatches(batches, captions, source, target, responseDeadline, onProgress);
    })();
    let timer;
    await Promise.race([complete, Promise.all([queueWork, directWork]),
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, responseDeadline - Date.now())); })]);
    if (timer) clearTimeout(timer);
  }
  writeResolvedCaches(captions, source, target);
  if (!allTranslated()) return $done(pendingCaptionResponse());
  let output = "";
  let position = 0;
  captions.forEach((caption) => {
    output += body.slice(position, caption.start);
    output += `<p${caption.attributes}><s ac="0">${encodeXml(caption.translated)}</s></p>`;
    position = caption.end;
  });
  output += body.slice(position);
  $done({status: 200, body: output, headers: {...rewrittenResponseHeaders(responseHeaders), "X-YouTube-Caption-State": "complete"}});
}

function pendingCaptionResponse() {
  return {status: 503, headers: {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Retry-After": "2", "X-YouTube-Caption-State": "pending"}, body: "Caption translation is still processing. Retry this caption request."};
}

if (typeof $response === "undefined") {
  $done({url: rewriteCaptionRequest($request.url)});
} else {
  translateCaptionResponse().catch((error) => {
    console.log(`Google caption translation failed: ${error}`);
    $done(pendingCaptionResponse());
  });
}
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
