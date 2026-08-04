/**
 * Remove mFood launch-screen and popup advertisements.
 *
 * Intercept requests before the real advertising payload reaches the app,
 * with a response-stage fallback for already-started requests. The splash
 * endpoint uses base64-encoded zlib data; the popup endpoint uses JSON.
 */

const EMPTY_COMPRESSED_LIST = "eJyLjgUAARUAuQ==";
const requestURL = $request.url || "";
const isSplash = requestURL.includes("/_list_spread-compress");
const isPopup = requestURL.includes("/_comprehensive_pop_list");

if (isSplash || isPopup) {
  const body = isSplash ? EMPTY_COMPRESSED_LIST : "[]";
  const contentType = isSplash
    ? "text/plain;charset=UTF-8"
    : "application/json;charset=UTF-8";

  if (typeof $response === "undefined") {
    $done({
      status: "HTTP/1.1 200 OK",
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": contentType
      },
      body
    });
  } else {
    const headers = { ...($response.headers || {}) };

    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "content-length") {
        delete headers[name];
      }
    }

    headers["Cache-Control"] = "no-store";
    headers["Content-Type"] = contentType;
    $done({ headers, body });
  }
} else {
  $done({});
}
