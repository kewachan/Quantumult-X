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
  const argument = Object.entries(options).map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(JSON.stringify(value))).join("&");

  (($request, $response, $done, $persistentStore, $prefs, $httpClient, $argument, $utils) => {
'use strict';

const body = typeof $response?.body === 'string' ? $response.body : '';

function decode(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === last && (first === '"' || first === "'"))
    ? value.slice(1, -1)
    : value;
}

function parseArguments(value) {
  const result = Object.create(null);
  if (typeof value !== 'string') return result;

  for (const part of value.split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const key = decode(separator === -1 ? part : part.slice(0, separator));
    const rawValue = separator === -1 ? '' : part.slice(separator + 1);
    if (key) result[key] = unquote(decode(rawValue).trim());
  }
  return result;
}

function readBoolean(argumentsMap, key, fallback) {
  const value = argumentsMap[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readUidSet(argumentsMap, key) {
  const value = argumentsMap[key];
  if (!value) return new Set();
  return new Set(String(value).split(',').map(item => item.trim()).filter(Boolean));
}

function isBanner(item) {
  return ['banner_v8', 'banner_ipad_v8'].includes(item?.card_type)
    && item?.card_goto === 'banner';
}

function isAdCard(item) {
  const cardType = item?.card_type;
  const cardGoto = item?.card_goto;

  if (['cm_v1', 'cm_v2'].includes(cardType)
    && ['ad_web_s', 'ad_av', 'ad_web_gif', 'ad_player', 'ad_inline_3d', 'ad_inline_eggs', 'ad_inline_live'].includes(cardGoto)) {
    return true;
  }
  if (cardType === 'cm_double_v9' && cardGoto === 'ad_inline_av') return true;
  if (cardType === 'large_cover_v9' && cardGoto === 'inline_av_v2') return true;
  return cardType === 'small_cover_v10' && cardGoto === 'game';
}

function filterItems(items, settings) {
  return items.filter(item => {
    if (isBanner(item)) {
      if (settings.removeActivity) return false;
      if (Array.isArray(item.banner_item)) {
        item.banner_item = item.banner_item.filter(entry => entry?.type !== 'ad');
      }
      return true;
    }

    if (isAdCard(item)) return false;
    if (settings.removeVertical && item?.goto === 'vertical_av') return false;

    const upId = item?.args?.up_id;
    if (item?.card_type === 'small_cover_v9'
      && item?.card_goto === 'live'
      && upId !== undefined
      && settings.blockedLiveUids.has(String(upId))) {
      return false;
    }
    return true;
  });
}

try {
  const argumentsMap = parseArguments(typeof $argument === 'string' ? $argument : '');
  const settings = {
    removeAds: readBoolean(argumentsMap, 'Feed.AD', true),
    removeActivity: readBoolean(argumentsMap, 'Feed.Activity', true),
    removeVertical: readBoolean(argumentsMap, 'Feed.Vertical', false),
    blockedLiveUids: readUidSet(argumentsMap, 'Feed.BlockUpLiveList')
  };
  const payload = JSON.parse(body);

  if (settings.removeAds && Array.isArray(payload?.data?.items)) {
    payload.data.items = filterItems(payload.data.items, settings);
    $done({ body: JSON.stringify(payload) });
  } else {
    $done({});
  }
} catch {
  $done({});
}
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
