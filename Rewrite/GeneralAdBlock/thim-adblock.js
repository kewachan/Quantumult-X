/**
 * THIM AdBlock for Quantumult X — v1.0.0
 * Removes the Home screen's complete Privilege Offers carousel by emptying only
 * the dedicated exclusive-banners placement response.
 */

(function () {
  "use strict";

  const ENDPOINT = /^https:\/\/service\.thim\.immigration\.go\.th\/api\/v1\/explore\/coupons\/exclusive-banners(?:\?[^#]*)?$/;
  const responseStatus = Number($response.statusCode || $response.status);

  if ($request.method !== "GET" || !ENDPOINT.test($request.url) ||
      responseStatus !== 200 || typeof $response.body !== "string") {
    $done({});
    return;
  }

  try {
    const payload = JSON.parse($response.body);
    if (!payload || payload.code !== "200.00" || payload.status !== "SUCCESS" ||
        !Array.isArray(payload.data) || payload.data.length === 0) {
      $done({});
      return;
    }

    payload.data = [];
    $done({ body: JSON.stringify(payload) });
  } catch (_) {
    // Preserve malformed or future response layouts instead of affecting THIM.
    $done({});
  }
})();
