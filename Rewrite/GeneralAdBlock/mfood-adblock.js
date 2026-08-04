/**
 * Remove mFood launch-screen and popup advertisements.
 *
 * Intercept requests before the real advertising payload reaches the app,
 * with a response-stage fallback for already-started requests. The splash
 * endpoint uses base64-encoded zlib data, popup lists use JSON arrays, and
 * special/floating-banner endpoints use an empty body when no ad exists.
 */

const EMPTY_COMPRESSED_LIST = "eJyLjgUAARUAuQ==";
const requestURL = $request.url || "";
const isSplash = requestURL.includes("/_list_spread-compress");
const isPopupList =
  requestURL.includes("/_comprehensive_pop_list") ||
  requestURL.includes("/getGroupPopList");
const isEmptyBodyBanner =
  requestURL.includes("/_special_list") ||
  requestURL.includes("/_list_suspend");

if (isSplash || isPopupList || isEmptyBodyBanner) {
  const body = isSplash
    ? EMPTY_COMPRESSED_LIST
    : isEmptyBodyBanner
      ? ""
      : "[]";
  const contentType = isSplash
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
      status: "HTTP/1.1 200 OK",
      headers,
      body
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
