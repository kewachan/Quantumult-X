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
  const argument = options;

  (($request, $response, $done, $persistentStore, $prefs, $httpClient, $argument, $utils) => {
/**
 * Reddit AdBlock for Surge — v1.0.0
 * Removes promoted posts from JSON and GraphQL multipart responses while
 * preserving normal feed entries and disabling NSFW content prompts.
 */

(function () {
  "use strict";

  const DROP = {};

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasAdCell(cells) {
    return Array.isArray(cells) && cells.some(function (cell) {
      return isObject(cell) &&
        (cell.__typename === "AdMetadataCell" || cell.isAdPost === true);
    });
  }

  function isAdObject(value) {
    if (!isObject(value)) return false;

    if (value.__typename === "AdPost" || value.isAdPost === true ||
        isObject(value.adPayload) || hasAdCell(value.cells)) {
      return true;
    }

    const node = value.node;
    return isObject(node) &&
      (node.__typename === "AdPost" || node.isAdPost === true ||
       isObject(node.adPayload) || hasAdCell(node.cells));
  }

  function cleanValue(value, state) {
    if (Array.isArray(value)) {
      const result = [];
      value.forEach(function (item) {
        const cleaned = cleanValue(item, state);
        if (cleaned !== DROP) result.push(cleaned);
      });
      return result;
    }

    if (!isObject(value)) return value;

    if (isAdObject(value)) {
      state.changed = true;
      return DROP;
    }

    if (value.isNsfw === true) {
      value.isNsfw = false;
      state.changed = true;
    }
    if (value.isNsfwMediaBlocked === true) {
      value.isNsfwMediaBlocked = false;
      state.changed = true;
    }
    if (value.isNsfwContentShown === false) {
      value.isNsfwContentShown = true;
      state.changed = true;
    }
    if (Array.isArray(value.commentsPageAds) && value.commentsPageAds.length > 0) {
      value.commentsPageAds = [];
      state.changed = true;
    }

    Object.keys(value).forEach(function (key) {
      const cleaned = cleanValue(value[key], state);
      if (cleaned === DROP) {
        delete value[key];
      } else {
        value[key] = cleaned;
      }
    });

    return value;
  }

  function transformJson(text) {
    try {
      const state = { changed: false };
      const cleaned = cleanValue(JSON.parse(text), state);
      if (cleaned === DROP || !state.changed) return null;
      return JSON.stringify(cleaned);
    } catch (_) {
      return null;
    }
  }

  function headerValue(headers, name) {
    const target = name.toLowerCase();
    const key = Object.keys(headers || {}).find(function (candidate) {
      return candidate.toLowerCase() === target;
    });
    return key ? String(headers[key]) : "";
  }

  function multipartBoundary(contentType) {
    const match = contentType.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
    return match ? match[1] : "";
  }

  function transformMultipart(body, boundary) {
    const delimiter = "--" + boundary;
    if (!boundary || body.indexOf(delimiter) === -1) return null;

    let changed = false;
    const segments = body.split(delimiter).map(function (segment) {
      let separator = "\r\n\r\n";
      let separatorIndex = segment.indexOf(separator);
      if (separatorIndex === -1) {
        separator = "\n\n";
        separatorIndex = segment.indexOf(separator);
      }
      if (separatorIndex === -1) return segment;

      const prefixEnd = separatorIndex + separator.length;
      const content = segment.slice(prefixEnd);
      const leading = (content.match(/^\s*/) || [""])[0];
      const trailing = (content.match(/\s*$/) || [""])[0];
      const jsonEnd = content.length - trailing.length;
      const jsonText = content.slice(leading.length, jsonEnd);
      if (!jsonText) return segment;

      const transformed = transformJson(jsonText);
      if (transformed === null) return segment;

      changed = true;
      return segment.slice(0, prefixEnd) + leading + transformed + trailing;
    });

    return changed ? segments.join(delimiter) : null;
  }

  if (typeof $response.body !== "string") {
    $done({});
    return;
  }

  const contentType = headerValue($response.headers, "content-type");
  let body = null;

  if (/multipart\/mixed/i.test(contentType)) {
    body = transformMultipart($response.body, multipartBoundary(contentType));
  } else {
    body = transformJson($response.body);
  }

  $done(body === null ? {} : { body: body });
})();
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
