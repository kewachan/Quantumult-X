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
  if (true && response) {
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
  if (true && request.bodyBytes) request.body = bytes(request.bodyBytes);
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
      if (true && bytes(qxResponse.bodyBytes)) output.bodyBytes = qxResponse.bodyBytes;
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
// Bilingual lyrics: AI cache -> dedicated AI Worker -> local Google fallback.
// Only lyric text and the requested language are sent to the Worker.

(() => {
  const WORKER_ENDPOINT = "https://youtube-lyrics-translate.hmtw47cv7m.workers.dev/lyrics";
  const GOOGLE_TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
  const LYRICS_RENDERER_FIELD = 465160965;
  const LYRICS_SOURCE_FIELD = 2;
  const TRANSLATE_CONTROL_FIELD = 24;
  const TRANSLATION_ATTRIBUTION_FIELD = 26;
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const CACHE_LIMIT = 64;
  const CACHE_INDEX_KEY = "YouTubeLyrics.CacheIndex.v7";
  const LEGACY_CACHE_INDEX_KEYS = ["YouTubeLyrics.CacheIndex.v3", "YouTubeLyrics.CacheIndex.v4", "YouTubeLyrics.CacheIndex.v5", "YouTubeLyrics.CacheIndex.v6"];
  const MAX_BATCH_ITEMS = 12;
  const MAX_BATCH_TOTAL_CHARS = 600;
  const CONCURRENCY = 3;
  const RESPONSE_BUDGET_MS = 9000;
  const WORKER_RESPONSE_BUDGET_MS = 6500;
  const GOOGLE_FALLBACK_RESERVE_MS = 2500;
  const TRANSLATE_TIMEOUT_SECONDS = 110;
  const MAX_BUSY_RETRIES = 0;
  const MAX_GOOGLE_ENCODED_QUERY_CHARS = 6000;
  const GOOGLE_TRANSLATE_TIMEOUT_SECONDS = 5;
  const GOOGLE_TRANSLATE_RETRIES = 1;
  const TEXT_ENCODER = new TextEncoder();
  const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

  function settings() {
    const output = { lyricsLang: "zh-Hant", lyricsToken: "", debug: false };
    try {
      if (typeof $argument === "string" && !$argument.includes("{{{")) {
        Object.assign(output, JSON.parse($argument));
      } else if (typeof $argument === "object" && $argument) {
        Object.assign(output, $argument);
      }
    } catch (_) {}
    return output;
  }

  function normalizeAccessToken(value) {
    const token = String(value || "").trim();
    return /^[a-f0-9]{64}$/i.test(token) ? token : "";
  }

  function normalizeLanguage(value) {
    const language = String(value || "").trim();
    if (!language || language.toLowerCase() === "off" || language.length > 32) return "off";
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) return "off";
    return {
      "zh-hant": "zh-Hant",
      "zh-hans": "zh-Hans",
      "zh-tw": "zh-TW",
      "zh-cn": "zh-CN",
    }[language.toLowerCase()] || language;
  }

  function responseBytes() {
    const body = $response?.bodyBytes ?? $response?.body;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return null;
  }

  function readVarint(bytes, position, limit) {
    let value = 0;
    let multiplier = 1;
    const start = position;
    while (position < limit && position - start < 10) {
      const byte = bytes[position++];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return [value, position];
      multiplier *= 128;
    }
    throw new Error("Invalid protobuf varint");
  }

  function encodeVarint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid protobuf value");
    const output = [];
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value) byte |= 0x80;
      output.push(byte);
    } while (value);
    return Uint8Array.from(output);
  }

  function parseMessage(bytes) {
    const fields = [];
    let position = 0;
    try {
      while (position < bytes.length) {
        const fieldStart = position;
        let tag;
        [tag, position] = readVarint(bytes, position, bytes.length);
        const number = Math.floor(tag / 8);
        const wireType = tag & 7;
        if (number < 1 || wireType === 3 || wireType === 4 || wireType > 5) return null;

        let dataStart = position;
        let dataEnd = position;
        if (wireType === 0) {
          [, position] = readVarint(bytes, position, bytes.length);
          dataEnd = position;
        } else if (wireType === 1) {
          position += 8;
          dataEnd = position;
        } else if (wireType === 2) {
          let length;
          [length, position] = readVarint(bytes, position, bytes.length);
          dataStart = position;
          position += length;
          dataEnd = position;
        } else {
          position += 4;
          dataEnd = position;
        }
        if (position > bytes.length) return null;
        fields.push({ number, wireType, fieldStart, fieldEnd: position, dataStart, dataEnd });
      }
    } catch (_) {
      return null;
    }
    return position === bytes.length ? fields : null;
  }

  function join(chunks) {
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  function encodeField(number, data) {
    return join([encodeVarint(number * 8 + 2), encodeVarint(data.length), data]);
  }

  function rawField(bytes, field) {
    return bytes.subarray(field.fieldStart, field.fieldEnd);
  }

  function fieldData(bytes, field) {
    return bytes.subarray(field.dataStart, field.dataEnd);
  }

  function decodeText(bytes) {
    try {
      const text = TEXT_DECODER.decode(bytes);
      return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? "" : text;
    } catch (_) {
      return "";
    }
  }

  function lyricList(rendererBytes) {
    const rendererFields = parseMessage(rendererBytes);
    if (!rendererFields) return null;
    const listField = rendererFields.find((field) => field.number === 4 && field.wireType === 2);
    if (!listField) return null;
    const listBytes = fieldData(rendererBytes, listField);
    const listFields = parseMessage(listBytes);
    if (!listFields) return null;

    const lines = [];
    for (const itemField of listFields) {
      if (itemField.number !== 1 || itemField.wireType !== 2) continue;
      const itemBytes = fieldData(listBytes, itemField);
      const itemFields = parseMessage(itemBytes);
      if (!itemFields?.some((field) => field.number === 2 && field.wireType === 2)) continue;
      const textField = itemFields.find((field) => field.number === 1 && field.wireType === 2);
      if (!textField) continue;
      const text = decodeText(fieldData(itemBytes, textField)).trim();
      if (text && text !== "♪") lines.push(text);
    }
    return lines.length >= 2 ? { rendererFields, listField, listBytes, listFields, lines } : null;
  }

  function findLyrics(bytes, depth = 0) {
    if (depth > 14) return null;
    const fields = parseMessage(bytes);
    if (!fields) return null;
    for (const field of fields) {
      if (field.wireType !== 2) continue;
      const data = fieldData(bytes, field);
      if (field.number === LYRICS_RENDERER_FIELD) {
        const list = lyricList(data);
        if (list) return list.lines;
      }
      if (data.length >= 4) {
        const nested = findLyrics(data, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  }

  function providerLabel(providers) {
    const normalized = new Set(Array.from(providers || [], (value) => String(value || "").toLowerCase()));
    if (normalized.size === 0) return "";
    const usedGoogle = Array.from(normalized).some((value) => value.includes("google"));
    const usedCloudflare = Array.from(normalized).some((value) => value.includes("cloudflare") || value.includes("workers-ai"));
    if (usedGoogle && usedCloudflare) return "Translated by Cloudflare AI + Google Translate";
    if (usedGoogle) return "Translated by Google Translate";
    return "Translated by Cloudflare AI";
  }

  function visibleAttribution(source, attribution) {
    const cleaned = String(source || "")
      .replace(/\s*(?:[·•|—-]\s*)?Translated by (?:Cloudflare AI|Google Translate|Cloudflare AI \+ Google Translate)\s*$/i, "")
      .trim();
    return cleaned ? `${cleaned}\n${attribution}` : attribution;
  }

  function rewriteLyricsRenderer(rendererBytes, translatedByOriginal, hideTranslateControl, attribution) {
    const lyrics = lyricList(rendererBytes);
    if (!lyrics) return [rendererBytes, false];
    let listChanged = false;
    let attributionHandled = false;
    let visibleAttributionHandled = false;
    const listChunks = [];

    for (const itemField of lyrics.listFields) {
      if (hideTranslateControl && itemField.number === TRANSLATE_CONTROL_FIELD && itemField.wireType === 2) {
        listChanged = true;
        continue;
      }
      if (attribution && itemField.number === TRANSLATION_ATTRIBUTION_FIELD && itemField.wireType === 2) {
        listChunks.push(encodeField(itemField.number, TEXT_ENCODER.encode(attribution)));
        attributionHandled = true;
        listChanged = true;
        continue;
      }
      if (attribution && itemField.number === LYRICS_SOURCE_FIELD && itemField.wireType === 2) {
        const source = decodeText(fieldData(lyrics.listBytes, itemField));
        listChunks.push(encodeField(itemField.number, TEXT_ENCODER.encode(visibleAttribution(source, attribution))));
        visibleAttributionHandled = true;
        listChanged = true;
        continue;
      }
      if (itemField.number !== 1 || itemField.wireType !== 2) {
        listChunks.push(rawField(lyrics.listBytes, itemField));
        continue;
      }
      const itemBytes = fieldData(lyrics.listBytes, itemField);
      const itemFields = parseMessage(itemBytes);
      const textField = itemFields?.find((field) => field.number === 1 && field.wireType === 2);
      if (!textField) {
        listChunks.push(rawField(lyrics.listBytes, itemField));
        continue;
      }
      const original = decodeText(fieldData(itemBytes, textField)).trim();
      const translated = translatedByOriginal.get(original)?.trim();
      if (!translated || translated === original || original === "♪") {
        listChunks.push(rawField(lyrics.listBytes, itemField));
        continue;
      }

      const bilingual = TEXT_ENCODER.encode(`${original}\n${translated}`);
      const itemChunks = itemFields.map((field) => (
        field === textField ? encodeField(field.number, bilingual) : rawField(itemBytes, field)
      ));
      listChunks.push(encodeField(itemField.number, join(itemChunks)));
      listChanged = true;
    }

    if (attribution && !attributionHandled) {
      listChunks.push(encodeField(TRANSLATION_ATTRIBUTION_FIELD, TEXT_ENCODER.encode(attribution)));
      listChanged = true;
    }
    if (attribution && !visibleAttributionHandled) {
      listChunks.push(encodeField(LYRICS_SOURCE_FIELD, TEXT_ENCODER.encode(attribution)));
      listChanged = true;
    }

    if (!listChanged) return [rendererBytes, false];
    const rewrittenList = join(listChunks);
    const rendererChunks = lyrics.rendererFields.map((field) => (
      field === lyrics.listField ? encodeField(field.number, rewrittenList) : rawField(rendererBytes, field)
    ));
    return [join(rendererChunks), true];
  }

  function rewriteNested(bytes, translatedByOriginal, depth = 0, hideTranslateControl = false, attribution = "") {
    if (depth > 14) return [bytes, false];
    const fields = parseMessage(bytes);
    if (!fields) return [bytes, false];
    let changed = false;
    const chunks = [];

    for (const field of fields) {
      if (field.wireType !== 2) {
        chunks.push(rawField(bytes, field));
        continue;
      }
      const data = fieldData(bytes, field);
      let rewritten = data;
      let fieldChanged = false;
      if (field.number === LYRICS_RENDERER_FIELD) {
        [rewritten, fieldChanged] = rewriteLyricsRenderer(data, translatedByOriginal, hideTranslateControl, attribution);
      }
      if (!fieldChanged && data.length >= 4) {
        [rewritten, fieldChanged] = rewriteNested(data, translatedByOriginal, depth + 1, hideTranslateControl, attribution);
      }
      if (fieldChanged) {
        chunks.push(encodeField(field.number, rewritten));
        changed = true;
      } else {
        chunks.push(rawField(bytes, field));
      }
    }
    return changed ? [join(chunks), true] : [bytes, false];
  }

  function cacheKey(lines, target) {
    let hash = 2166136261;
    const value = `${target}|${lines.join("\u001f")}`;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `YouTubeLyrics.v6.${(hash >>> 0).toString(16)}`;
  }

  function buildTranslationBatches(lines) {
    const batches = [];
    let batch = [];
    let characters = 0;
    for (const line of lines) {
      if (batch.length && (batch.length >= MAX_BATCH_ITEMS || characters + line.length > MAX_BATCH_TOTAL_CHARS)) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push(line);
      characters += line.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function isAIResult(result) {
    return ["cloudflare-ai", "workers-ai-cache"].includes(String(result?.provider || "").toLowerCase());
  }

  function cacheRecord(result) {
    const savedAt = Number(result?.savedAt || Date.now());
    return {
      savedAt,
      expiresAt: Number(result?.expiresAt || (savedAt + CACHE_TTL_MS)),
      translations: result.translations,
      provider: result.provider,
      cacheStatus: String(result?.cacheStatus || ""),
    };
  }

  function clearLegacyCaches() {
    if (typeof $persistentStore === "undefined") return;
    for (const indexKey of LEGACY_CACHE_INDEX_KEYS) {
      try {
        const stored = JSON.parse($persistentStore.read(indexKey) || "[]");
        if (Array.isArray(stored)) {
          stored.forEach((item) => {
            if (item?.key) $persistentStore.write("", item.key);
          });
        }
      } catch (_) {}
      $persistentStore.write("", indexKey);
    }
  }

  function readCache(key, expectedLength) {
    if (typeof $persistentStore === "undefined") return null;
    try {
      const cached = JSON.parse($persistentStore.read(key) || "null");
      const record = cached ? cacheRecord(cached) : null;
      if (
        record && Array.isArray(record.translations)
        && record.translations.length === expectedLength
        && Date.now() < record.expiresAt
        && isAIResult(record)
      ) return record;
      if (cached) $persistentStore.write("", key);
    } catch (_) {}
    return null;
  }

  function writeCache(key, result) {
    if (typeof $persistentStore === "undefined" || !isAIResult(result)) return;
    try {
      const record = cacheRecord(result);
      const savedAt = record.savedAt;
      $persistentStore.write(JSON.stringify(record), key);
      const stored = JSON.parse($persistentStore.read(CACHE_INDEX_KEY) || "[]");
      const now = Date.now();
      const index = (Array.isArray(stored) ? stored : [])
        .filter((item) => (
          item?.key && item.key !== key
          && Number(item.expiresAt || (Number(item.savedAt || 0) + CACHE_TTL_MS)) > now
        ));
      index.push({ key, savedAt, expiresAt: record.expiresAt });
      while (index.length > CACHE_LIMIT) {
        const expired = index.shift();
        if (expired?.key) $persistentStore.write("", expired.key);
      }
      $persistentStore.write(JSON.stringify(index), CACHE_INDEX_KEY);
    } catch (_) {}
  }

  function requestTranslations(lines, target, timeoutSeconds, accessToken) {
    const payload = JSON.stringify({ purpose: "lyrics", texts: lines, source: "auto", target });
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    if (typeof $httpClient !== "undefined") {
      return new Promise((resolve, reject) => {
        $httpClient.post({
          url: WORKER_ENDPOINT,
          timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
          headers,
          body: payload,
        }, (error, response, body) => {
          if (error) return reject(error);
          try {
            const status = response.status || response.statusCode;
            if (status !== 200) {
              const statusError = new Error(`Worker status ${status}`);
              statusError.status = status;
              throw statusError;
            }
            const result = JSON.parse(body);
            if (!isAIResult(result)) throw new Error("Worker returned a non-AI lyric result");
            if (!Array.isArray(result?.translations) || result.translations.length !== lines.length) {
              throw new Error("Invalid Worker translation response");
            }
            resolve({
              translations: result.translations.map((line) => String(line || "")),
              provider: String(result.provider || "cloudflare-ai"),
              cacheStatus: String(result.cacheStatus || ""),
            });
          } catch (parseError) {
            reject(parseError);
          }
        });
      });
    }
    if (typeof $task !== "undefined") {
      return $task.fetch({
        url: WORKER_ENDPOINT,
        method: "POST",
        timeout: timeoutSeconds,
        headers,
        body: payload,
      }).then((response) => {
        if (response.statusCode !== 200) {
          const statusError = new Error(`Worker status ${response.statusCode}`);
          statusError.status = response.statusCode;
          throw statusError;
        }
        const result = JSON.parse(response.body);
        if (!isAIResult(result)) throw new Error("Worker returned a non-AI lyric result");
        if (!Array.isArray(result?.translations) || result.translations.length !== lines.length) {
          throw new Error("Invalid Worker translation response");
        }
        return {
          translations: result.translations.map((line) => String(line || "")),
          provider: String(result.provider || "cloudflare-ai"),
          cacheStatus: String(result.cacheStatus || ""),
        };
      });
    }
    return Promise.reject(new Error("No HTTP client available"));
  }

  function googleTargetLanguage(language) {
    return {
      "zh-hant": "zh-TW",
      "zh-tw": "zh-TW",
      "zh-hans": "zh-CN",
      "zh-cn": "zh-CN",
    }[String(language || "").toLowerCase()] || language;
  }

  function googleSeparator(index) {
    return `\n[[YTL:${index}]]\n`;
  }

  function googleQuery(lines) {
    return lines.map((line, index) => `${index ? googleSeparator(index) : ""}${line}`).join("");
  }

  function buildGoogleBatches(lines) {
    const batches = [];
    let batch = [];
    for (const line of lines) {
      const candidate = [...batch, line];
      if (batch.length && encodeURIComponent(googleQuery(candidate)).length > MAX_GOOGLE_ENCODED_QUERY_CHARS) {
        batches.push(batch);
        batch = [];
      }
      batch.push(line);
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function parseGoogleTranslation(body, status) {
    if (status !== 200) {
      const error = new Error(`Google Translate status ${status}`);
      error.status = status;
      throw error;
    }
    const result = JSON.parse(body);
    if (!Array.isArray(result?.[0])) throw new Error("Invalid Google Translate response");
    return result[0].map((part) => part?.[0] || "").join("");
  }

  function requestGoogleText(query, target, timeoutSeconds) {
    const url = `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(googleTargetLanguage(target))}&dt=t&q=${encodeURIComponent(query)}`;
    const request = {
      url,
      timeout: typeof $loon !== "undefined" ? timeoutSeconds * 1000 : timeoutSeconds,
      headers: { Accept: "application/json" },
    };
    if (typeof $httpClient !== "undefined") {
      return new Promise((resolve, reject) => {
        $httpClient.get(request, (error, response, body) => {
          if (error) return reject(error);
          try {
            resolve(parseGoogleTranslation(body, response.status || response.statusCode));
          } catch (parseError) {
            reject(parseError);
          }
        });
      });
    }
    if (typeof $task !== "undefined") {
      return $task.fetch({ ...request, method: "GET", timeout: timeoutSeconds }).then((response) => (
        parseGoogleTranslation(response.body, response.statusCode || response.status)
      ));
    }
    return Promise.reject(new Error("No HTTP client available"));
  }

  async function fetchGoogleText(query, target, deadline) {
    let lastError;
    for (let attempt = 0; attempt <= GOOGLE_TRANSLATE_RETRIES; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lastError || new Error("Google Translate time budget exhausted");
      const timeout = Math.max(1, Math.min(GOOGLE_TRANSLATE_TIMEOUT_SECONDS, Math.ceil(remaining / 1000)));
      try {
        return await requestGoogleText(query, target, timeout);
      } catch (error) {
        lastError = error;
        if (attempt === GOOGLE_TRANSLATE_RETRIES) break;
        const delay = 200;
        if (Date.now() + delay >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError || new Error("Google Translate failed");
  }

  async function translateGoogleBatch(lines, target, deadline) {
    const translated = await fetchGoogleText(googleQuery(lines), target, deadline);
    if (lines.length === 1) return [translated.trim()];
    const parts = translated.split(/\s*\[\[\s*YTL\s*:\s*\d+\s*\]\]\s*/gi);
    if (parts.length === lines.length) return parts.map((part) => part.trim());
    const middle = Math.ceil(lines.length / 2);
    const [left, right] = await Promise.all([
      translateGoogleBatch(lines.slice(0, middle), target, deadline),
      translateGoogleBatch(lines.slice(middle), target, deadline),
    ]);
    return [...left, ...right];
  }

  async function fetchGoogleTranslations(lines, target, deadline) {
    const batches = buildGoogleBatches(lines);
    const translations = (await Promise.all(
      batches.map((batch) => translateGoogleBatch(batch, target, deadline)),
    )).flat();
    if (translations.length !== lines.length) throw new Error("Incomplete Google lyric translation");
    return { translations, provider: "google-translate" };
  }

  async function fetchWorkerTranslations(lines, target, deadline, accessToken) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lastError || new Error("Lyrics translation time budget exhausted");
      const timeout = Math.max(0.1, Math.min(TRANSLATE_TIMEOUT_SECONDS, remaining / 1000));
      try {
        return await requestTranslations(lines, target, timeout, accessToken);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_BUSY_RETRIES || Number(error?.status) !== 429) break;
        const delay = 5000;
        if (Date.now() + delay >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError || new Error("Worker lyrics translation failed");
  }

  async function fetchTranslations(lines, target, deadline, accessToken) {
    if (!accessToken) return fetchGoogleTranslations(lines, target, deadline);

    let workerError;
    const now = Date.now();
    const workerDeadline = Math.min(
      deadline - GOOGLE_FALLBACK_RESERVE_MS,
      now + WORKER_RESPONSE_BUDGET_MS,
    );
    if (workerDeadline > now) {
      try {
        return await fetchWorkerTranslations(lines, target, workerDeadline, accessToken);
      } catch (error) {
        workerError = error;
      }
    } else {
      workerError = new Error("Worker skipped to preserve Google fallback budget");
    }
    const status = Number(workerError?.status || 0);
    if (status && status !== 429 && status < 500) throw workerError;
    try {
      return await fetchGoogleTranslations(lines, target, deadline);
    } catch (googleError) {
      throw new Error(`Worker failed (${String(workerError)}); Google fallback failed (${String(googleError)})`);
    }
  }

  async function main() {
    const options = settings();
    const target = normalizeLanguage(options.lyricsLang);
    const accessToken = normalizeAccessToken(options.lyricsToken);
    const input = responseBytes();
    if (target === "off" || !input) return $done({});
    if (!accessToken && options.debug) {
      console.log("YouTube lyrics access token is missing or invalid; using Google Translate");
    }

    clearLegacyCaches();
    const [inputWithoutControl, controlChanged] = rewriteNested(input, new Map(), 0, true);
    const lines = findLyrics(inputWithoutControl);
    if (!lines) return $done(controlChanged ? { body: inputWithoutControl } : {});
    const uniqueLines = [...new Set(lines)];
    try {
      const translatedByOriginal = new Map();
      const providers = new Set();
      const deadline = Date.now() + RESPONSE_BUDGET_MS;
      const batches = buildTranslationBatches(uniqueLines);
      let cursor = 0;
      async function worker() {
        while (cursor < batches.length && Date.now() < deadline) {
          const batch = batches[cursor++];
          const key = cacheKey(batch, target);
          let result = readCache(key, batch.length);
          if (!result) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            try {
              result = await fetchTranslations(batch, target, deadline, accessToken);
              writeCache(key, result);
            } catch (error) {
              console.log(`YouTube lyrics translation batch failed: ${String(error)}`);
              continue;
            }
          }
          let batchChanged = false;
          batch.forEach((line, index) => {
            const translatedLine = result.translations[index];
            translatedByOriginal.set(line, translatedLine);
            if (String(translatedLine || "").trim() !== line.trim()) batchChanged = true;
          });
          if (batchChanged) providers.add(result.provider);
        }
      }
      const work = Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
      let timer;
      await Promise.race([
        work,
        new Promise((resolve) => { timer = setTimeout(resolve, RESPONSE_BUDGET_MS); }),
      ]);
      if (timer) clearTimeout(timer);
      if (translatedByOriginal.size !== uniqueLines.length) {
        throw new Error(`Incomplete lyrics translation (${translatedByOriginal.size}/${uniqueLines.length})`);
      }

      const attribution = providerLabel(providers);
      const [output, translated] = rewriteNested(inputWithoutControl, translatedByOriginal, 0, false, attribution);
      const changed = controlChanged || translated;
      if (options.debug) console.log(`YouTube lyrics: ${translated ? attribution : "already matches target language"}; translate control ${controlChanged ? "hidden" : "absent"} (${translatedByOriginal.size}/${uniqueLines.length} unique lines)`);
      return $done(changed ? { body: output } : {});
    } catch (error) {
      console.log(`YouTube lyrics translation failed: ${String(error)}`);
      return $done(controlChanged ? { body: inputWithoutControl } : {});
    }
  }

  main().catch((error) => {
    console.log(`YouTube lyrics translation failed: ${String(error)}`);
    $done({});
  });
})();
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
