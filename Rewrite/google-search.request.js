// Normalize Google search defaults without re-encoding query values.
(function () {
  "use strict";
  try {
    if (($request.method || "GET").toUpperCase() !== "GET") return $done({});
    const url = String($request.url || "");
    if (/[\r\n]/.test(url)) return $done({});
    const match = /^(https?:\/\/www\.google\.com\/search\?)([^#]*)(#.*)?$/.exec(url);
    if (!match) return $done({});
    const parts = match[2].split("&").map(raw => {
      const at = raw.indexOf("=");
      const key = at < 0 ? raw : raw.slice(0, at);
      return {raw, key: decodeURIComponent(key.replace(/\+/g, " ")), value: at < 0 ? "" : raw.slice(at + 1)};
    });
    if (!parts.some(part => part.key === "q" && part.value !== "") ||
        parts.some(part => part.key === "udm" || part.key === "tbm")) return $done({});
    const hasClient = parts.some(part => part.key === "client");
    const query = hasClient
      ? [...parts.filter(part => !["client", "gl", "safe"].includes(part.key)).map(part => part.raw), "gl=hk", "safe=off", "udm=14"].join("&")
      : "udm=14&" + match[2];
    const target = match[1] + query + (match[3] || "");
    if (target === url) return $done({});
    $done({status: "HTTP/1.1 302 Found", headers: {Location: target, "Cache-Control": "no-store"}, body: ""});
  } catch (_) {
    $done({});
  }
})();
