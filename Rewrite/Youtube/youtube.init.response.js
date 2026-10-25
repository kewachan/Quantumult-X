(function () {
  "use strict";

  function concatBytes(...chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }


  function equalBytes(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    return difference === 0;
  }


  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }


  function decodeBase64(value) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = Object.create(null);
    for (let index = 0; index < alphabet.length; index++) lookup[alphabet[index]] = index;
    const input = String(value).replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
    const output = [];
    let buffer = 0;
    let bits = 0;
    for (const character of input) {
      if (character === "=") break;
      const decoded = lookup[character];
      if (decoded === undefined) throw new Error("Invalid base64 client key");
      buffer = (buffer << 6) | decoded;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output.push((buffer >>> bits) & 0xff);
      }
    }
    return new Uint8Array(output);
  }


  function readProtoVarint(bytes, offset) {
    const start = offset;
    let value = 0;
    let multiplier = 1;
    for (let count = 0; count < 10 && offset < bytes.length; count++) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return { value, start, end: offset };
      multiplier *= 128;
    }
    throw new Error(`Invalid protobuf varint at ${start}`);
  }


  function parseProto(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
      const start = offset;
      const tag = readProtoVarint(bytes, offset);
      offset = tag.end;
      const no = Math.floor(tag.value / 8);
      const wire = tag.value & 7;
      if (no < 1) throw new Error("Invalid protobuf field number");
      let value;
      if (wire === 0) {
        value = readProtoVarint(bytes, offset);
        offset = value.end;
      } else if (wire === 1) {
        offset += 8;
      } else if (wire === 2) {
        const length = readProtoVarint(bytes, offset);
        offset = length.end;
        const end = offset + length.value;
        if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error(`Truncated protobuf field ${no}`);
        value = bytes.subarray(offset, end);
        offset = end;
      } else if (wire === 5) {
        offset += 4;
      } else {
        throw new Error(`Unsupported protobuf wire type ${wire}`);
      }
      if (offset > bytes.length) throw new Error(`Truncated protobuf field ${no}`);
      fields.push({ no, wire, value, raw: bytes.subarray(start, offset) });
    }
    return fields;
  }


  function firstProtoField(fields, no, wire) {
    return fields.find((field) => field.no === no && field.wire === wire);
  }


  function readUmpVarint(bytes, offset) {
    if (offset >= bytes.length) throw new Error("Truncated UMP varint");
    const first = bytes[offset];
    const size = first < 0x80 ? 1 : first < 0xc0 ? 2 : first < 0xe0 ? 3 : first < 0xf0 ? 4 : 5;
    if (offset + size > bytes.length) throw new Error("Truncated UMP varint");
    let value;
    if (size === 1) value = first;
    else if (size === 2) value = (first & 0x3f) + 64 * bytes[offset + 1];
    else if (size === 3) value = (first & 0x1f) + 32 * (bytes[offset + 1] + 256 * bytes[offset + 2]);
    else if (size === 4) value = (first & 0x0f) + 16 * (bytes[offset + 1] + 256 * (bytes[offset + 2] + 256 * bytes[offset + 3]));
    else value = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, true);
    return { value, end: offset + size };
  }


  function parseUmp(bytes) {
    const parts = [];
    let offset = 0;
    while (offset < bytes.length) {
      const type = readUmpVarint(bytes, offset);
      const length = readUmpVarint(bytes, type.end);
      const end = length.end + length.value;
      if (end > bytes.length) throw new Error("Truncated UMP part");
      parts.push({ type: type.value, data: bytes.subarray(length.end, end) });
      offset = end;
    }
    return parts;
  }


  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotateRight(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  function sha256(message) {
    const bitLength = message.length * 8;
    const totalLength = Math.ceil((message.length + 9) / 64) * 64;
    const padded = new Uint8Array(totalLength);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(totalLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(totalLength - 4, bitLength >>> 0, false);
    const hash = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < totalLength; offset += 64) {
      for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
      for (let index = 16; index < 64; index++) {
        const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index++) {
        const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temporary1 = (h + sigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
        const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temporary2 = (sigma0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temporary1) >>> 0;
        d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0;
      hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0;
      hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0;
      hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0;
      hash[7] = (hash[7] + h) >>> 0;
    }
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    for (let index = 0; index < hash.length; index++) outputView.setUint32(index * 4, hash[index], false);
    return output;
  }

  function hmacSha256(key, message) {
    let normalizedKey = key.length > 64 ? sha256(key) : key;
    if (normalizedKey.length < 64) {
      const padded = new Uint8Array(64);
      padded.set(normalizedKey);
      normalizedKey = padded;
    }
    const innerPad = new Uint8Array(64);
    const outerPad = new Uint8Array(64);
    for (let index = 0; index < 64; index++) {
      innerPad[index] = normalizedKey[index] ^ 0x36;
      outerPad[index] = normalizedKey[index] ^ 0x5c;
    }
    return sha256(concatBytes(outerPad, sha256(concatBytes(innerPad, message))));
  }

  const KEY_RING_PREFIX = "YouTubePlaybackKeys.v2.";
  const MAX_BYTES = 24 * 1024 * 1024;
  const WORKER = "https://youtube-init.hmtw47cv7m.workers.dev/transform";

  function argumentsMap() {
    const options = { captionLang: "zh-Hant", debug: false };
    const fragment = String(typeof $environment === "undefined" ? "" : $environment.sourcePath || "").split("#").slice(1).join("#");
    for (const field of fragment.split("&")) {
      const at = field.indexOf("=");
      if (at < 0) continue;
      const key = decodeURIComponent(field.slice(0, at));
      if (key === "captionLang") options.captionLang = decodeURIComponent(field.slice(at + 1));
      if (key === "debug") options.debug = /^(true|1)$/i.test(field.slice(at + 1));
    }
    if (!/^(?:off|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(options.captionLang)) options.captionLang = "zh-Hant";
    return options;
  }

  function header(headers, name) {
    const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name);
    return key === undefined ? "" : headers[key];
  }

  function readState(platform) {
    try { return JSON.parse($prefs.valueForKey(KEY_RING_PREFIX + platform) || "{}"); }
    catch (_) { return {}; }
  }

  function candidateKeys(platform) {
    const state = readState(platform), values = [];
    for (const entry of (Array.isArray(state.entries) ? state.entries : []).slice(0, 8)) {
      if (entry && entry.expiresAt > Date.now()) values.push(entry.clientKey);
    }
    try {
      const config = JSON.parse($prefs.valueForKey("YouTubeConfig") || "{}");
      if (config[platform]?.clientKey) values.push(config[platform].clientKey);
    } catch (_) {}
    const keys = [];
    for (const value of values) {
      try {
        const bytes = decodeBase64(value);
        if (bytes.length === 32 && !keys.some(key => equalBytes(key.bytes, bytes))) keys.push({ value, bytes });
      } catch (_) {}
    }
    return keys.slice(0, 8);
  }

  function authenticatedKey(parts, candidates) {
    let encrypted = false;
    for (const part of parts) {
      if (part.type === 10) {
        encrypted = firstProtoField(parseProto(part.data), 1, 0)?.value?.value === 25;
      } else if (part.type === 11 && encrypted) {
        const fields = parseProto(part.data);
        const ciphertext = firstProtoField(fields, 1, 2)?.value;
        const signature = firstProtoField(fields, 2, 2)?.value;
        const iv = firstProtoField(fields, 3, 2)?.value;
        if (!ciphertext || signature?.length !== 32 || iv?.length !== 16) throw new Error("Invalid encrypted part");
        const signed = concatBytes(ciphertext, iv);
        return candidates.find(key => equalBytes(signature, hmacSha256(key.bytes.subarray(16), signed))) || null;
      }
    }
    return undefined;
  }

  let completed = false, deadline;
  function finish(value) {
    if (completed) return;
    completed = true;
    if (deadline) clearTimeout(deadline);
    $done(value);
  }

  try {
    const input = toBytes($response.bodyBytes), options = argumentsMap();
    if ($response.statusCode !== 200 || !input?.length || input.length > MAX_BYTES ||
        !String(header($response.headers, "content-type")).toLowerCase().includes("application/vnd.yt-ump")) return finish({});
    const platform = String(header($request.headers, "user-agent")).toLowerCase().includes("music") ? "youtubeMusic" : "youtube";
    const parts = parseUmp(input), key = authenticatedKey(parts, candidateKeys(platform));
    if (key === undefined) return finish({});
    if (!key) {
      const state = readState(platform);
      state.refreshNeeded = true;
      $prefs.setValueForKey(JSON.stringify(state), KEY_RING_PREFIX + platform);
      console.log("YouTube initplayback: playback key refresh requested");
      return finish({});
    }
    deadline = setTimeout(() => {
      console.log("YouTube initplayback: transform timeout; original response kept");
      finish({});
    }, 8000);
    $task.fetch({
      url: WORKER + "?ck=" + encodeURIComponent(key.value) + "&captionLang=" + encodeURIComponent(options.captionLang),
      method: "POST", headers: { "Content-Type": "application/vnd.yt-ump" },
      bodyBytes: input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength),
      opts: { policy: "direct" }
    }).then(response => {
      if (completed) return;
      const output = toBytes(response.bodyBytes);
      const result = String(header(response.headers, "x-youtube-adblock"));
      if (response.statusCode !== 200 || !output?.length || output.length > MAX_BYTES || !/^removed-\d+$/.test(result)) {
        console.log("YouTube initplayback: invalid transform response; original response kept");
        return finish({});
      }
      const transformed = parseUmp(output);
      if (transformed.length !== parts.length || transformed.some((part, index) => part.type !== parts[index].type ||
          part.type !== 11 && !equalBytes(part.data, parts[index].data))) throw new Error("UMP structure changed");
      if (options.debug) console.log("YouTube initplayback: " + result);
      finish(equalBytes(input, output) ? {} : { bodyBytes: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) });
    }).catch(() => {
      console.log("YouTube initplayback: transform failed; original response kept");
      finish({});
    });
  } catch (_) {
    console.log("YouTube initplayback: unsupported response; original response kept");
    finish({});
  }
})();
