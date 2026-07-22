// Translate YouTube srv3 captions with Google's public web translation endpoint.
// No account or API key is required. Public endpoint limits still apply.

const TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_ENCODED_QUERY_CHARS = 7000;
const CONCURRENCY = 8;
const RESPONSE_BUDGET_MS = 24000;
const TRANSLATE_TIMEOUT_SECONDS = 9;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 96;
const CACHE_INDEX_KEY = "YouTubeCaption.CacheIndex.v2";

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
  return `YouTubeCaption.v2.${(hash >>> 0).toString(16)}`;
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
  const target = getQueryValue(url, "tlang");
  if (!target) return url;
  return url.replace(/([?&])tlang=([^&#]*)/, (_, separator, value) =>
    `${separator}enhance_tlang=${encodeURIComponent(mapTargetLanguage(decodeURIComponent(value)))}`,
  );
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

function separator(index) {
  return `\n[[YTS:${index}]]\n`;
}

function buildBatches(captions) {
  const batches = [];
  let items = [];
  let query = "";
  captions.forEach((caption, index) => {
    const addition = `${items.length ? separator(index) : ""}${caption.text}`;
    if (items.length && encodeURIComponent(query + addition).length > MAX_ENCODED_QUERY_CHARS) {
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

function requestTranslation(query, source, target, timeout) {
  const url = `${TRANSLATE_ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(query)}`;
  return new Promise((resolve, reject) => {
    $httpClient.get({url, timeout, headers: {Accept: "application/json"}}, (error, response, body) => {
      if (error) return reject(error);
      try {
        const status = response.status || response.statusCode;
        if (status !== 200) throw new Error(`Google Translate status ${status}`);
        const result = JSON.parse(body);
        if (!Array.isArray(result?.[0])) throw new Error("Invalid Google Translate response");
        resolve(result[0].map((part) => part?.[0] || "").join(""));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function fetchTranslation(query, source, target, deadline) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError || new Error("Caption translation time budget exhausted");
    try {
      const timeout = Math.max(1, Math.min(TRANSLATE_TIMEOUT_SECONDS, Math.ceil(remaining / 1000)));
      return await requestTranslation(query, source, target, timeout);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      const delay = 250 * (2 ** attempt);
      if (Date.now() + delay >= deadline) break;
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

async function translateBatches(batches, captions, source, target) {
  const queue = [...batches];
  const deadline = Date.now() + RESPONSE_BUDGET_MS;
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length && Date.now() < deadline) {
      const batch = queue[cursor++];
      try {
        const key = cacheKey(batch.query, source, target);
        let parts = readCachedParts(key, batch.items.length);
        if (!parts) {
          const translated = await fetchTranslation(batch.query, source, target, deadline);
          parts = translated.split(/\s*\[\[YTS:\s*\d+\s*\]\]\s*/g);
          if (parts.length === batch.items.length) writeCachedParts(key, parts);
        }
        if (parts.length !== batch.items.length) {
          if (batch.items.length > 1) {
            const middle = Math.ceil(batch.items.length / 2);
            queue.push(rebuildBatch(batch.items.slice(0, middle), captions));
            queue.push(rebuildBatch(batch.items.slice(middle), captions));
          }
          continue;
        }
        batch.items.forEach((item, index) => { captions[item.captionIndex].translated = parts[index].trim(); });
      } catch (error) {
        console.log(`Google caption batch failed: ${error}`);
      }
    }
  }
  const work = Promise.all(Array.from({length: Math.min(CONCURRENCY, queue.length)}, worker));
  let timer;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, RESPONSE_BUDGET_MS); })]);
  if (timer) clearTimeout(timer);
}

async function translateCaptionResponse() {
  const target = mapTargetLanguage(getQueryValue($request.url, "enhance_tlang") || getQueryValue($request.url, "tlang"));
  const source = getQueryValue($request.url, "lang") || "auto";
  if (!target || !$response.body) return $done({});

  const body = $response.body;
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

  await translateBatches(buildBatches(captions), captions, source, target);
  let output = "";
  let position = 0;
  captions.forEach((caption) => {
    output += body.slice(position, caption.start);
    output += `<p${caption.attributes}><s ac="0">${encodeXml(caption.translated || caption.text)}</s></p>`;
    position = caption.end;
  });
  output += body.slice(position);
  $done({body: output, headers: {...$response.headers, "Content-Type": "text/xml; charset=utf-8"}});
}

if (typeof $response === "undefined") {
  $done({url: rewriteCaptionRequest($request.url)});
} else {
  translateCaptionResponse().catch((error) => {
    console.log(`Google caption translation failed: ${error}`);
    $done({});
  });
}
