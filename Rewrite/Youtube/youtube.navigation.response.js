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
(() => {
  const responseBody = $response.body;
  const input = responseBody instanceof Uint8Array
    ? responseBody
    : responseBody instanceof ArrayBuffer
      ? new Uint8Array(responseBody)
      : null;

  if (!input) {
    $done({});
    return;
  }

  const readVarint = (bytes, position, limit) => {
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
  };

  const encodeVarint = value => {
    let remaining = value;
    const output = [];

    while (remaining > 0x7f) {
      output.push((remaining % 128) | 0x80);
      remaining = Math.floor(remaining / 128);
    }

    output.push(remaining);
    return Uint8Array.from(output);
  };

  const parseMessage = bytes => {
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
    } catch {
      return null;
    }

    return position === bytes.length ? fields : null;
  };

  const join = chunks => {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }

    return output;
  };

  const encodeField = (number, data) => join([
    encodeVarint(number * 8 + 2),
    encodeVarint(data.length),
    data
  ]);

  const rawField = (bytes, field) => bytes.subarray(field.fieldStart, field.fieldEnd);
  const fieldData = (bytes, field) => bytes.subarray(field.dataStart, field.dataEnd);

  const looksLikePlayer = (bytes, fields) => {
    const numbers = new Set(fields.map(field => field.number));
    if (![1, 2, 4, 9].every(number => numbers.has(number))) return false;
    if (numbers.has(7) || numbers.has(68)) return true;

    return fields.some(field => {
      if (field.number !== 9 || field.wireType !== 2) return false;
      const trackingFields = parseMessage(fieldData(bytes, field));
      return trackingFields?.some(trackingField => trackingField.number === 18) ?? false;
    });
  };

  const cleanPlaybackTracking = bytes => {
    const fields = parseMessage(bytes);
    if (!fields) return [bytes, false];

    let changed = false;
    const chunks = [];

    for (const field of fields) {
      if (field.number === 18) {
        changed = true;
      } else {
        chunks.push(rawField(bytes, field));
      }
    }

    return changed ? [join(chunks), true] : [bytes, false];
  };

  const cleanPlayer = (bytes, fields) => {
    let changed = false;
    const chunks = [];

    for (const field of fields) {
      if (field.number === 7 || field.number === 68) {
        changed = true;
        continue;
      }

      if (field.number === 9 && field.wireType === 2) {
        const [tracking, trackingChanged] = cleanPlaybackTracking(fieldData(bytes, field));
        if (trackingChanged) {
          chunks.push(encodeField(field.number, tracking));
          changed = true;
          continue;
        }
      }

      chunks.push(rawField(bytes, field));
    }

    return changed ? [join(chunks), true] : [bytes, false];
  };

  const cleanNested = (bytes, depth = 0) => {
    const fields = parseMessage(bytes);
    if (!fields) return [bytes, false];
    if (looksLikePlayer(bytes, fields)) return cleanPlayer(bytes, fields);
    if (depth >= 8) return [bytes, false];

    let changed = false;
    const chunks = [];

    for (const field of fields) {
      if (field.wireType === 2 && field.dataEnd - field.dataStart >= 1024) {
        const [nested, nestedChanged] = cleanNested(fieldData(bytes, field), depth + 1);
        if (nestedChanged) {
          chunks.push(encodeField(field.number, nested));
          changed = true;
          continue;
        }
      }

      chunks.push(rawField(bytes, field));
    }

    return changed ? [join(chunks), true] : [bytes, false];
  };

  try {
    const rootFields = parseMessage(input);
    if (!rootFields) {
      $done({});
      return;
    }

    let changed = false;
    const chunks = [];

    for (const field of rootFields) {
      if (field.number === 2 && field.wireType === 2) {
        const [nested, nestedChanged] = cleanNested(fieldData(input, field));
        if (nestedChanged) {
          chunks.push(encodeField(field.number, nested));
          changed = true;
          continue;
        }
      }

      chunks.push(rawField(input, field));
    }

    $done(changed ? { body: join(chunks) } : {});
  } catch (error) {
    console.log(`YouTube navigation cleanup failed: ${String(error)}`);
    $done({});
  }
})();
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
