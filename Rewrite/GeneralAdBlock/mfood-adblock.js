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
 * Remove mFood launch-screen, popup, floating, and in-page advertisements.
 *
 * Intercept requests before the real advertising payload reaches the app,
 * with a response-stage fallback for already-started requests. The splash
 * endpoint uses base64-encoded zlib data, most ad lists use
 * JSON arrays, and special/floating-banner endpoints use an empty body when no
 * ad exists.
 */

const EMPTY_COMPRESSED_LIST = "eJyLjgUAARUAuQ==";
const requestURL = $request.url || "";
const requestMethod = ($request.method || "").toUpperCase();
const isCompressedList = requestURL.includes("/_list_spread-compress");
const isJSONList =
  requestURL.includes("/_comprehensive_pop_list") ||
  requestURL.includes("/getGroupPopList") ||
  requestURL.includes("/_get_pop_list") ||
  requestURL.includes("/activity/activity/topPop/list") ||
  requestURL.includes("/market/user_side/banner/_get_banner_list") ||
  requestURL.includes("/orgs/banner/advertisement/_get_banner_list") ||
  requestURL.includes("/orgs/banner/advertisement/_get_advertisement_list") ||
  requestURL.includes(
    "/orgs/banner/advertisement/_activity_advertisement_list"
  );
const isEmptyBodyBanner =
  requestURL.includes("/_special_list") ||
  requestURL.includes("/_new_special_list") ||
  requestURL.includes("/_list_suspend") ||
  requestURL.includes("/_list_smart") ||
  requestURL.includes("/orgs/basic/banner/bottom/banner/_list") ||
  requestURL.includes("/activity/userActivity/getPop");
const isNewPeopleAd = requestURL.includes(
  "/market/market/zone/_new-people-ad"
);

if (requestMethod === "OPTIONS") {
  $done({});
} else if (isCompressedList || isJSONList || isEmptyBodyBanner || isNewPeopleAd) {
  const body = isCompressedList
    ? EMPTY_COMPRESSED_LIST
    : isEmptyBodyBanner
      ? ""
      : isNewPeopleAd
        ? '{"imgUrl":null}'
        : "[]";
  const contentType = isCompressedList
    ? "text/plain;charset=UTF-8"
    : isEmptyBodyBanner
      ? ""
      : "application/json;charset=UTF-8";

  if (typeof $response === "undefined") {
    const headers = { "Cache-Control": "no-store" };
    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    $done({
      response: {
        status: 200,
        headers,
        body
      }
    });
  } else {
    const headers = { ...($response.headers || {}) };

    for (const name of Object.keys(headers)) {
      const lowerName = name.toLowerCase();
      if (
        lowerName === "content-length" ||
        (isEmptyBodyBanner && lowerName === "content-type")
      ) {
        delete headers[name];
      }
    }

    headers["Cache-Control"] = "no-store";
    if (contentType) {
      headers["Content-Type"] = contentType;
    }
    $done({ headers, body });
  }
} else {
  $done({});
}
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
