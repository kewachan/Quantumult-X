(() => {
  const url = $request.url || "";
  const original = $response.body;
  if (typeof original !== "string" || Number($response.statusCode || 200) !== 200) return $done({});
  const youtube = /^https:\/\/www\.youtube\.com\//.test(url);
  const bilibili = /^https:\/\/(?:www|api)\.bilibili\.com\//.test(url);
  const bahamut = /^https:\/\/(?:ani|api)\.gamer\.com\.tw\//.test(url);
  if (!youtube && !bilibili && !bahamut) return $done({});
  const DROP = {};
  const adArrays = new Set(["playerAds", "adPlacements", "adSlots"]);
  const adRenderers = new Set([
    "adSlotRenderer", "adLayoutRenderer", "displayAdRenderer", "promotedVideoRenderer",
    "promotedSparklesWebRenderer", "promotedSparklesTextSearchRenderer", "inFeedAdLayoutRenderer",
    "mastheadAdRenderer", "brandVideoSingletonRenderer", "searchPyvRenderer",
    "instreamVideoAdRenderer", "actionCompanionAdRenderer"
  ]);
  let removed = 0, tracks = 0;
  let language = "zh-Hant";
  try {
    const fragment = String($environment.sourcePath || "").split("#")[1] || "";
    const value = fragment.match(/(?:^|&)captionLang=([^&]*)/);
    if (value) language = decodeURIComponent(value[1]);
  } catch (_) {}
  const target = ({"zh-Hant": "zh-TW", "zh-Hans": "zh-CN"})[language] || language;
  function parameter(base, key, value) {
    const fragmentIndex = base.indexOf("#");
    const fragment = fragmentIndex < 0 ? "" : base.slice(fragmentIndex);
    let output = fragmentIndex < 0 ? base : base.slice(0, fragmentIndex);
    const pattern = new RegExp("([?&])" + key + "=[^&]*");
    if (pattern.test(output)) output = output.replace(pattern, "$1" + key + "=" + encodeURIComponent(value));
    else output += (output.includes("?") ? "&" : "?") + key + "=" + encodeURIComponent(value);
    return output + fragment;
  }
  function addCaptionTrack(value) {
    const list = value.captionTracks;
    if (language === "off" || !Array.isArray(list) || !list.length) return;
    if (list.some(track => typeof track.baseUrl === "string" && /[?&]enhance_tlang=/.test(track.baseUrl))) return;
    const source = list.find(track => typeof track.baseUrl === "string" && !/[?&]tlang=/.test(track.baseUrl));
    if (!source || !/^https:\/\/www\.youtube\.com\/api\/timedtext\?/.test(source.baseUrl)) return;
    list.push({ ...source, baseUrl: parameter(source.baseUrl, "enhance_tlang", target),
      name: { simpleText: "Enhance (" + language + ")" }, vssId: ".enhance." + language,
      languageCode: language, isTranslatable: false });
    tracks++;
  }
  function clean(value) {
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) { const next = clean(item); if (next !== DROP) result.push(next); }
      return result;
    }
    if (!value || typeof value !== "object") return value;
    if (youtube && Object.keys(value).some(key => adRenderers.has(key))) { removed++; return DROP; }
    if (bilibili && (value.is_ad === true || value.is_ad === 1 || value.is_ad === "1" || value.goto === "ad")) { removed++; return DROP; }
    const result = {};
    for (const key of Object.keys(value)) {
      if (youtube && adArrays.has(key) && Array.isArray(value[key])) {
        removed += value[key].length; result[key] = []; continue;
      }
      const next = clean(value[key]);
      if (next !== DROP) result[key] = next;
    }
    if (youtube && result.playerCaptionsTracklistRenderer) addCaptionTrack(result.playerCaptionsTracklistRenderer);
    if (youtube && value.richItemRenderer?.content && result.richItemRenderer && !result.richItemRenderer.content) return DROP;
    if (youtube && value.richItemRenderer && !result.richItemRenderer) return DROP;
    if (bahamut && result.ad && typeof result.ad === "object") {
      for (const key of ["minor", "major"]) if (Array.isArray(result.ad[key])) { removed += result.ad[key].length; result.ad[key] = []; }
    }
    return result;
  }
  function endOfJSON(text, start) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth++;
      else if (character === "}" || character === "]") { if (--depth === 0) return index + 1; }
    }
    return -1;
  }
  function embedded(text) {
    const pattern = /(?:(?:var|let|const)\s+)?(?:ytInitialPlayerResponse|ytInitialData|window\[(?:"|')(?:ytInitialPlayerResponse|ytInitialData|__INITIAL_STATE__)(?:"|')\]|window\.__INITIAL_STATE__|__INITIAL_STATE__)\s*=\s*/g;
    const replacements = [];
    let match;
    while ((match = pattern.exec(text))) {
      const start = pattern.lastIndex;
      if (text[start] !== "{" && text[start] !== "[") continue;
      const end = endOfJSON(text, start);
      if (end < 0) continue;
      try {
        const before = removed + tracks;
        const value = clean(JSON.parse(text.slice(start, end)));
        if (value !== DROP && removed + tracks !== before) replacements.push({ start, end, text: JSON.stringify(value).replace(/</g, "\\u003c") });
        pattern.lastIndex = end;
      } catch (_) {}
    }
    for (const replacement of replacements.reverse()) text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
    return text;
  }
  try {
    let body = original;
    if (/^\s*[\[{]/.test(body)) {
      const value = clean(JSON.parse(body));
      if (value !== DROP && removed + tracks) body = JSON.stringify(value);
    } else if (/<html\b|<!doctype\b/i.test(body)) {
      body = embedded(body);
      const css = youtube
        ? "ytd-ad-slot-renderer,ytd-display-ad-renderer,ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,#masthead-ad,#player-ads{display:none!important}"
        : bilibili ? '.bili-video-card:has(a[href*="cm.bilibili.com"]),.bili-video-card:has(a[href*="ad.bilibili.com"]){display:none!important}'
        : '[id^="div-gpt-ad-"]{display:none!important}';
      if (!body.includes('id="qx-desktop-enhance"')) {
        const nonce = (body.match(/<style\b[^>]*\bnonce=["']([^"']+)["']/i) || [])[1];
        const style = '<style id="qx-desktop-enhance"' + (nonce ? ' nonce="' + nonce.replace(/["<>]/g, "") + '"' : "") + ">" + css + "</style>";
        if (/<\/head\s*>/i.test(body)) body = body.replace(/<\/head\s*>/i, style + "</head>");
      }
    }
    if (body === original) return $done({});
    console.log("Desktop " + (youtube ? "YouTube" : bilibili ? "Bilibili" : "Bahamut") + ": removed=" + removed + ", captionTracks=" + tracks);
    $done({ body, headers: { ...$response.headers, "X-QX-Desktop-Enhance": "1" } });
  } catch (_) { $done({}); }
})();
