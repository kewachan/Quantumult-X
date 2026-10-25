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
 * Yahoo Finance AdBlock for Surge
 *
 * Disables native ad placements through Yahoo's remote configuration.
 */

const isYahooConfig = /^https:\/\/config\.mobile\.yahoo\.com\/V3\/getconfig(?:\?.*)?$/i.test(
  $request.url
);

if (!isYahooConfig) {
  $done({});
} else if (typeof $response === "undefined") {
  const headers = Object.assign({}, $request.headers);

  Object.keys(headers).forEach(function(key) {
    if (/^if-(?:none-match|modified-since)$/i.test(key)) {
      delete headers[key];
    }
  });

  $done({ headers: headers });
} else {
  try {
    const response = JSON.parse($response.body || "{}");
    const features =
      response.feature &&
      response.feature["com.yahoo.finance"];

    if (!features) {
      $done({});
    } else {
      [
        "ArticleKit_EnableLargeCardAdOnOffnetArticle",
        "ArticleKit_EnableMoreStoriesAd",
        "ArticleKit_EnablePencilAds",
        "ArticleKit_EnableSponsoredMoments",
        "enableUPCHomePencilAd",
        "homeAdsModuleUpdate",
        "homeNewsForYouAdsUpdate",
        "pencilAdEnabled",
        "prefetchTopMarketsAd",
        "prefetchTopQSPAd",
        "sponsored_moments_ad_enabled",
        "sponsored_moments_gam_edge_to_edge_article_ad_enabled",
        "sponsored_moments_gam_edge_to_edge_stream_ad_enabled",
        "sponsored_moments_native_qsp_pencil_ad_enabled",
        "sponsored_moments_prebidsdk_support",
        "sponsored_moments_taboola_article_pencil_ad_enabled",
        "sponsored_moments_taboola_article_recirc_ad_enabled",
        "sponsored_moments_taboola_new_home_stream_ad_enabled",
        "sponsored_moments_taboola_stream_ad_enabled",
        "topAdPlacementQSP",
        "topMarketsAd"
      ].forEach(function(key) {
        features[key] = false;
      });

      features.sponsored_moments_news_stream_ad_position = 9999;
      features.sponsored_moments_quotes_stream_ad_position = 9999;
      features.streamAdFetchCount = 0;

      $done({ body: JSON.stringify(response) });
    }
  } catch (_) {
    $done({});
  }
}
  })(request, response, done, store, prefs, http, argument, undefined);
})($done, $request, typeof $response === "undefined" ? undefined : $response, typeof $environment === "undefined" ? {} : $environment);
