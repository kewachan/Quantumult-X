(() => {
  "use strict";
  const STAGING_KEY = "YouTubeHotConfigBootstrap.v1.youtubeMusic";
  let completed = false, deadline;
  const finish = () => {
    if (completed) return;
    completed = true;
    if (deadline) clearTimeout(deadline);
    $done({});
  };
  const bytes = value => value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  const header = name => Object.entries($request.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1] || "";

  function fields(source) {
    const read = offset => {
      let value = 0, multiplier = 1;
      for (let count = 0; count < 10 && offset < source.length; count++) {
        const byte = source[offset++]; value += (byte & 127) * multiplier;
        if (!(byte & 128)) return [value, offset];
        multiplier *= 128;
      }
      throw new Error("Invalid bootstrap varint");
    };
    const output = [];
    let offset = 0;
    while (offset < source.length) {
      const start = offset, [tag, afterTag] = read(offset), number = Math.floor(tag / 8), wire = tag % 8;
      if (number < 1 || number > 536870911) throw new Error("Invalid bootstrap field");
      offset = afterTag;
      let value;
      if (wire === 0) [value, offset] = read(offset);
      else if (wire === 1) offset += 8;
      else if (wire === 2) {
        const [length, first] = read(offset), end = first + length;
        if (!Number.isSafeInteger(end) || end > source.length) throw new Error("Truncated bootstrap field");
        value = source.subarray(first, end); offset = end;
      } else if (wire === 5) offset += 4;
      else throw new Error("Unsupported bootstrap field");
      if (offset > source.length) throw new Error("Truncated bootstrap field");
      output.push({ number, wire, value, raw: source.subarray(start, offset) });
    }
    return output;
  }
  const field = (source, number) => fields(source).find(item => item.number === number && item.wire === 2);
  function base64(source) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    for (let index = 0; index < source.length; index += 3) {
      const value = source[index] * 65536 + (source[index + 1] || 0) * 256 + (source[index + 2] || 0);
      output += alphabet[value >>> 18] + alphabet[value >>> 12 & 63] +
        (index + 1 < source.length ? alphabet[value >>> 6 & 63] : "=") +
        (index + 2 < source.length ? alphabet[value & 63] : "=");
    }
    return output;
  }

  try {
    const body = bytes($request.bodyBytes);
    if ($request.method !== "POST" || !/^https:\/\/youtubei\.googleapis\.com\/youtubei\/v1\/mdx\/handoff(?:\?|$)/.test($request.url || "") ||
        !String(header("user-agent")).toLowerCase().includes("youtubemusic") ||
        !/^application\/(?:x-)?protobuf(?:;|$)/i.test(header("content-type")) || !body?.length || body.length > 1024 * 1024) return finish();
    const context = field(body, 1);
    if (!context?.value?.length) return finish();
    const headers = Object.fromEntries(Object.entries($request.headers || {}).filter(([name]) =>
      !/^(?:host|:authority|connection|te|trailer|transfer-encoding|content-length|content-encoding|accept-encoding|x-youtube-hot-hash-data)$/i.test(name)));
    deadline = setTimeout(finish, 2500);
    $task.fetch({
      url: "https://youtubei.googleapis.com/youtubei/v1/log_event", method: "POST", headers,
      bodyBytes: context.raw.buffer.slice(context.raw.byteOffset, context.raw.byteOffset + context.raw.byteLength),
      opts: { redirection: false }
    }).then(result => {
      if (completed) return;
      try {
        const type = Object.entries(result.headers || {}).find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
        let hot = bytes(result.bodyBytes);
        if (result.statusCode !== 200 || !/^application\/(?:x-)?protobuf(?:;|$)/i.test(type) || !hot?.length || hot.length > 1024 * 1024) return finish();
        for (const number of [1, 16, 7, 138536474, 146311580]) hot = hot && field(hot, number)?.value;
        if (hot && field(hot, 1)?.value?.length === 32 && field(hot, 2)?.value?.length) {
          let state;
          try { state = JSON.parse($prefs.valueForKey(STAGING_KEY) || "{}"); } catch (_) { state = {}; }
          const now = Date.now(), session = String($request.sessionIndex ?? "");
          const entries = (Array.isArray(state?.entries) ? state.entries : []).filter(entry =>
            entry && now - entry.savedAt >= 0 && now - entry.savedAt < 60000 && entry.session !== session);
          entries.unshift({ session, savedAt: now, hotConfig: base64(hot) });
          $prefs.setValueForKey(JSON.stringify({ entries: entries.slice(0, 4) }), STAGING_KEY);
        }
      } catch (_) { console.log("YouTube Music bootstrap: unsupported config kept"); }
      finish();
    }, finish);
  } catch (_) { finish(); }
})();
