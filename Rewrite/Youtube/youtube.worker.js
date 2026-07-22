const GOOGLEVIDEO_HOST = /^[a-z0-9-]+\.googlevideo\.com$/i;
const INITIAL_UPSTREAM_PATH = "/initplayback";
const INITIAL_UPSTREAM_PATHS = new Set([INITIAL_UPSTREAM_PATH]);
const REDIRECTED_UPSTREAM_PATHS = new Set([INITIAL_UPSTREAM_PATH, "/videoplayback"]);
const UMP_CONTENT_TYPE = "application/vnd.yt-ump";
const ENCRYPTED_INNERTUBE_RESPONSE = 25;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
// The Worker has a 128 MB isolate limit, while decrypting, decompressing, and
// rewriting a UMP response can temporarily keep several full-size copies.
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_CLIENT_KEY_CHARS = 64;
const UPSTREAM_TIMEOUT_MS = 25000;
const TEXT_ENCODER = new TextEncoder();
const PAGEAD_MARKER = TEXT_ENCODER.encode("pagead");
const YT_ADS_WEBVIEW_MARKER = TEXT_ENCODER.encode("yt-ads-web-view-id");
const INLINE_INJECTION_ENTRYPOINT_MARKER = TEXT_ENCODER.encode("inline_injection_entrypoint_layout.eml");
const SHOPPING_TIMELY_SHELF_MARKER = TEXT_ENCODER.encode("shopping_timely_shelf.eml-fe");
const PRODUCT_LOCATION_TIMELY_SHELF_MARKER = TEXT_ENCODER.encode("PRODUCT_LOCATION_TIMELY_SHELF");

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
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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

function encodeProtoVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid protobuf varint value");
  const output = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    output.push(byte);
  } while (value !== 0);
  return new Uint8Array(output);
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

function encodeLengthDelimitedField(no, value) {
  return concatBytes(
    encodeProtoVarint(no * 8 + 2),
    encodeProtoVarint(value.length),
    value,
  );
}

function encodeVarintField(no, value) {
  return concatBytes(
    encodeProtoVarint(no * 8),
    encodeProtoVarint(value),
  );
}

function upsertLengthDelimitedFields(bytes, replacements) {
  const fields = parseProto(bytes);
  const output = [];
  const replaced = new Set();
  for (const field of fields) {
    if (field.wire === 2 && replacements.has(field.no)) {
      if (!replaced.has(field.no)) {
        output.push(encodeLengthDelimitedField(field.no, replacements.get(field.no)));
        replaced.add(field.no);
      }
    } else {
      output.push(field.raw);
    }
  }
  for (const [no, value] of replacements) {
    if (!replaced.has(no)) output.push(encodeLengthDelimitedField(no, value));
  }
  return concatBytes(...output);
}

function containsBytes(bytes, needle) {
  outer: for (let index = 0; index <= bytes.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function rewriteLengthDelimitedField(bytes, no, rewriter) {
  const fields = parseProto(bytes);
  const output = [];
  let changed = false;
  for (const field of fields) {
    if (field.no === no && field.wire === 2) {
      const replacement = rewriter(field.value);
      if (replacement === null) {
        changed = true;
        continue;
      }
      if (!equalBytes(replacement, field.value)) {
        changed = true;
        output.push(encodeLengthDelimitedField(no, replacement));
      } else {
        output.push(field.raw);
      }
    } else {
      output.push(field.raw);
    }
  }
  return changed ? concatBytes(...output) : bytes;
}

function containsRichItemAdSignal(bytes) {
  // The pagead marker is sufficient at the known rich-item boundary,
  // RichItemContent boundary, while inline injection is a known ad EML. The
  // web-view marker covers newer variants which omit the other two signals.
  // Visible labels such as "Sponsored" are localized and intentionally unused.
  return containsBytes(bytes, PAGEAD_MARKER)
    || containsBytes(bytes, YT_ADS_WEBVIEW_MARKER)
    || containsBytes(bytes, INLINE_INJECTION_ENTRYPOINT_MARKER);
}

function containsStrongStandaloneAdSignal(bytes) {
  // Outside the known rich-item boundary, keep the stricter legacy check to
  // avoid treating generic pagead analytics in comments or filter chips as an
  // entire ad renderer.
  return (
    containsBytes(bytes, PAGEAD_MARKER)
    && containsBytes(bytes, YT_ADS_WEBVIEW_MARKER)
  ) || containsBytes(bytes, INLINE_INJECTION_ENTRYPOINT_MARKER);
}

function containsTimelyShoppingShelf(bytes) {
  return containsBytes(bytes, PRODUCT_LOCATION_TIMELY_SHELF_MARKER)
    || containsBytes(bytes, SHOPPING_TIMELY_SHELF_MARKER);
}

function firstLengthDelimitedValue(bytes, no) {
  return parseProto(bytes).find((field) => field.no === no && field.wire === 2)?.value;
}

function isWatchNextChipRow(bytes) {
  try {
    const renderer = firstLengthDelimitedValue(bytes, 50195462);
    const content = renderer && firstLengthDelimitedValue(renderer, 5);
    const chipShelf = content && firstLengthDelimitedValue(content, 188360221);
    const chipContent = chipShelf && firstLengthDelimitedValue(chipShelf, 1);
    const chipList = chipContent && firstLengthDelimitedValue(chipContent, 90823135);
    if (!chipList) return false;

    let chips = 0;
    for (const field of parseProto(chipList)) {
      if (
        field.no === 1
        && field.wire === 2
        && parseProto(field.value).some((child) => child.no === 91394224 && child.wire === 2)
      ) chips++;
    }
    return chips >= 2;
  } catch {
    return false;
  }
}

function stripItemSectionRichAds(bytes) {
  let fields;
  try {
    fields = parseProto(bytes);
  } catch {
    return { bytes, removed: 0 };
  }

  const output = [];
  let removed = 0;
  for (const field of fields) {
    // ItemSectionRenderer.richItemContents. YouTube can place the chip row,
    // recommendations, and a Sponsored card in the same item section. Remove
    // only the rich item carrying a known ad signal.
    if (field.no === 1 && field.wire === 2 && containsRichItemAdSignal(field.value)) {
      removed++;
      continue;
    }
    output.push(field.raw);
  }

  return {
    bytes: removed > 0 ? concatBytes(...output) : bytes,
    removed,
  };
}

function stripCommentAreaAdRenderers(bytes, depth = 0) {
  if (!containsRichItemAdSignal(bytes) || depth > 16) {
    return { bytes, removed: 0 };
  }

  let fields;
  try {
    fields = parseProto(bytes);
  } catch {
    return { bytes, removed: 0 };
  }

  const output = [];
  let removed = 0;
  let changed = false;
  for (const field of fields) {
    if (field.wire !== 2 || !containsRichItemAdSignal(field.value)) {
      output.push(field.raw);
      continue;
    }

    if (field.no === 50195462) {
      const richItems = stripItemSectionRichAds(field.value);
      if (richItems.removed > 0) {
        removed += richItems.removed;
        changed = true;
        if (richItems.bytes.length > 0) {
          output.push(encodeLengthDelimitedField(field.no, richItems.bytes));
        }
        continue;
      }

      // This exact renderer owns the watch-page filter chips (All, Related,
      // For you, etc.). Its payload may contain ad-like tracking strings, but
      // without an ad rich item the renderer must remain byte-for-byte intact.
      if (isWatchNextChipRow(field.raw)) {
        output.push(field.raw);
        continue;
      }

      // Older responses used a standalone ad renderer instead of a mixed item
      // section. It is safe to remove only after the chip and rich-item checks,
      // and only when the stronger standalone signal is present.
      if (!containsStrongStandaloneAdSignal(field.value)) {
        output.push(field.raw);
        continue;
      }
      removed++;
      changed = true;
      continue;
    }

    const nested = stripCommentAreaAdRenderers(field.value, depth + 1);
    removed += nested.removed;
    if (nested.removed > 0) {
      changed = true;
      output.push(encodeLengthDelimitedField(field.no, nested.bytes));
    } else {
      output.push(field.raw);
    }
  }

  return {
    bytes: changed ? concatBytes(...output) : bytes,
    removed,
  };
}

function stripTimelyShoppingShelf(nextBytes) {
  if (!containsTimelyShoppingShelf(nextBytes)) {
    return { bytes: nextBytes, removed: 0 };
  }

  let nextFields;
  try {
    nextFields = parseProto(nextBytes);
  } catch {
    return { bytes: nextBytes, removed: 0 };
  }

  const nextOutput = [];
  let removed = 0;
  let changed = false;
  for (const nextField of nextFields) {
    // The metadata carousel directly below a video is delivered in the
    // framework-update branch, not in the watch-next recommendation list:
    // NextResponse.frameworkUpdates(14) -> extension 78882851 -> updates(42).
    // Drop only the update identified as PRODUCT_LOCATION_TIMELY_SHELF. Other
    // metadata updates (comments, chapters, chips, etc.) remain byte-for-byte.
    if (
      nextField.no !== 14
      || nextField.wire !== 2
      || !containsTimelyShoppingShelf(nextField.value)
    ) {
      nextOutput.push(nextField.raw);
      continue;
    }

    let frameworkFields;
    try {
      frameworkFields = parseProto(nextField.value);
    } catch {
      nextOutput.push(nextField.raw);
      continue;
    }

    const frameworkOutput = [];
    let frameworkChanged = false;
    for (const frameworkField of frameworkFields) {
      if (
        frameworkField.no !== 78882851
        || frameworkField.wire !== 2
        || !containsTimelyShoppingShelf(frameworkField.value)
      ) {
        frameworkOutput.push(frameworkField.raw);
        continue;
      }

      let updateFields;
      try {
        updateFields = parseProto(frameworkField.value);
      } catch {
        frameworkOutput.push(frameworkField.raw);
        continue;
      }

      const updateOutput = [];
      let updateChanged = false;
      for (const updateField of updateFields) {
        if (
          updateField.no === 42
          && updateField.wire === 2
          && containsTimelyShoppingShelf(updateField.value)
        ) {
          removed++;
          updateChanged = true;
          continue;
        }
        updateOutput.push(updateField.raw);
      }

      if (updateChanged) {
        frameworkChanged = true;
        frameworkOutput.push(encodeLengthDelimitedField(
          frameworkField.no,
          concatBytes(...updateOutput),
        ));
      } else {
        frameworkOutput.push(frameworkField.raw);
      }
    }

    if (frameworkChanged) {
      changed = true;
      nextOutput.push(encodeLengthDelimitedField(nextField.no, concatBytes(...frameworkOutput)));
    } else {
      nextOutput.push(nextField.raw);
    }
  }

  return {
    bytes: changed ? concatBytes(...nextOutput) : nextBytes,
    removed,
  };
}

function stripNextResponseAds(nextBytes) {
  try {
    // Walk richItemContents across the complete decoded response, not
    // only the initial Next.content field. A recursive protobuf walk also
    // covers continuation actions and newly introduced wrapper fields while
    // the unique ItemSectionRenderer extension keeps deletion tightly scoped.
    const adResult = stripCommentAreaAdRenderers(nextBytes);
    const shoppingResult = stripTimelyShoppingShelf(adResult.bytes);
    return {
      bytes: shoppingResult.bytes,
      removed: adResult.removed + shoppingResult.removed,
    };
  } catch (error) {
    console.error("YouTube NextResponse ad content was left unchanged:", error);
    return { bytes: nextBytes, removed: 0 };
  }
}

function replaceLengthDelimitedFields(bytes, replacements) {
  const fields = parseProto(bytes);
  const output = [];
  const replaced = new Set();
  for (const field of fields) {
    if (field.wire === 2 && replacements.has(field.no) && !replaced.has(field.no)) {
      output.push(encodeLengthDelimitedField(field.no, replacements.get(field.no)));
      replaced.add(field.no);
    } else {
      output.push(field.raw);
    }
  }
  if (replaced.size !== replacements.size) throw new Error("Required encrypted response field is missing");
  return concatBytes(...output);
}

function enhancePlayabilityStatus(playabilityBytes) {
  const pictureInPictureAbility = concatBytes(
    encodeVarintField(1, 1),
    encodeVarintField(8, 1),
  );
  const pictureInPictureRender = encodeLengthDelimitedField(151635310, pictureInPictureAbility);
  const backgroundAbility = encodeVarintField(1, 1);
  const backgroundPlayerRender = encodeLengthDelimitedField(64657230, backgroundAbility);

  return upsertLengthDelimitedFields(playabilityBytes, new Map([
    [11, backgroundPlayerRender],
    [21, pictureInPictureRender],
  ]));
}

function stripPlayerAds(playerBytes) {
  const fields = parseProto(playerBytes);
  const output = [];
  let removed = 0;
  let enhanced = false;

  for (const field of fields) {
    // PlayerResponse.adPlacements and PlayerResponse.adSlots.
    if ((field.no === 7 || field.no === 68) && field.wire === 2) {
      removed++;
      continue;
    }

    // PlayerResponse.playabilityStatus: enable background playback and PiP.
    if (field.no === 2 && field.wire === 2) {
      const playabilityStatus = enhancePlayabilityStatus(field.value);
      if (!equalBytes(playabilityStatus, field.value)) {
        enhanced = true;
        output.push(encodeLengthDelimitedField(2, playabilityStatus));
      } else {
        output.push(field.raw);
      }
      continue;
    }

    // PlayerResponse.playbackTracking.pageadViewthroughconversion.
    if (field.no === 9 && field.wire === 2) {
      const nestedFields = parseProto(field.value);
      const filtered = nestedFields.filter((nested) => nested.no !== 18);
      const nestedRemoved = nestedFields.length - filtered.length;
      if (nestedRemoved > 0) {
        removed += nestedRemoved;
        output.push(encodeLengthDelimitedField(9, concatBytes(...filtered.map((nested) => nested.raw))));
        continue;
      }
    }

    output.push(field.raw);
  }

  return {
    bytes: removed > 0 || enhanced ? concatBytes(...output) : playerBytes,
    removed,
    enhanced,
  };
}

function stripOnesieResponseAds(clearBytes) {
  const fields = parseProto(clearBytes);
  const output = [];
  let removed = 0;
  let enhanced = 0;

  for (const field of fields) {
    if (field.no === 4 && field.wire === 2) {
      const bodyFields = parseProto(field.value);
      const isPlayerEnvelope = bodyFields.some((bodyField) => bodyField.no === 7 && bodyField.wire === 0)
        && bodyFields.some((bodyField) => bodyField.no === 10 && bodyField.wire === 0);
      let result;

      if (isPlayerEnvelope) {
        const bodyOutput = [];
        let bodyRemoved = 0;
        let bodyEnhanced = 0;
        for (const bodyField of bodyFields) {
          // Content.player is field 2. Field 3 is Content.next and must never be
          // parsed as PlayerResponse because it contains watch metadata and comments.
          if (bodyField.no === 2 && bodyField.wire === 2) {
            const playerResult = stripPlayerAds(bodyField.value);
            bodyRemoved += playerResult.removed;
            bodyEnhanced += Number(playerResult.enhanced);
            bodyOutput.push(
              playerResult.removed > 0 || playerResult.enhanced
                ? encodeLengthDelimitedField(bodyField.no, playerResult.bytes)
                : bodyField.raw,
            );
          } else if (bodyField.no === 3 && bodyField.wire === 2) {
            const nextResult = stripNextResponseAds(bodyField.value);
            bodyRemoved += nextResult.removed;
            bodyOutput.push(
              nextResult.removed > 0
                ? encodeLengthDelimitedField(bodyField.no, nextResult.bytes)
                : bodyField.raw,
            );
          } else {
            bodyOutput.push(bodyField.raw);
          }
        }
        result = {
          bytes: bodyRemoved > 0 || bodyEnhanced > 0 ? concatBytes(...bodyOutput) : field.value,
          removed: bodyRemoved,
          enhanced: bodyEnhanced,
        };
      } else {
        // Unknown content types are preserved byte-for-byte. Treating an
        // arbitrary field 7 as adPlacements can destroy NextResponse content.
        result = { bytes: field.value, removed: 0, enhanced: 0 };
      }

      removed += result.removed;
      enhanced += result.enhanced;
      output.push(
        result.removed > 0 || result.enhanced > 0
          ? encodeLengthDelimitedField(4, result.bytes)
          : field.raw,
      );
    } else {
      output.push(field.raw);
    }
  }

  return {
    bytes: removed > 0 || enhanced > 0 ? concatBytes(...output) : clearBytes,
    removed,
    enhanced,
  };
}

function readUmpVarint(bytes, offset) {
  if (offset >= bytes.length) throw new Error("Truncated UMP varint");
  const first = bytes[offset];
  const size = first < 0x80 ? 1 : first < 0xc0 ? 2 : first < 0xe0 ? 3 : first < 0xf0 ? 4 : 5;
  if (offset + size > bytes.length) throw new Error("Truncated UMP varint");

  let value;
  if (size === 1) {
    value = first;
  } else if (size === 2) {
    value = (first & 0x3f) + 64 * bytes[offset + 1];
  } else if (size === 3) {
    value = (first & 0x1f) + 32 * (bytes[offset + 1] + 256 * bytes[offset + 2]);
  } else if (size === 4) {
    value = (first & 0x0f) + 16 * (bytes[offset + 1] + 256 * (bytes[offset + 2] + 256 * bytes[offset + 3]));
  } else {
    value = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, true);
  }
  return { value, end: offset + size };
}

function encodeUmpVarint(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid UMP varint value");
  if (value < 0x80) return new Uint8Array([value]);
  if (value < 0x4000) return new Uint8Array([(value & 0x3f) | 0x80, value >>> 6]);
  if (value < 0x200000) return new Uint8Array([(value & 0x1f) | 0xc0, (value >>> 5) & 0xff, value >>> 13]);
  if (value < 0x10000000) {
    return new Uint8Array([(value & 0x0f) | 0xe0, (value >>> 4) & 0xff, (value >>> 12) & 0xff, value >>> 20]);
  }
  const output = new Uint8Array(5);
  output[0] = 0xf0;
  new DataView(output.buffer).setUint32(1, value, true);
  return output;
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

function encodeUmp(parts) {
  return concatBytes(...parts.flatMap((part) => [
    encodeUmpVarint(part.type),
    encodeUmpVarint(part.data.length),
    part.data,
  ]));
}

function firstProtoField(fields, no, wire) {
  return fields.find((field) => field.no === no && field.wire === wire);
}

async function transformCompression(bytes, format, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(
    mode === "compress" ? new CompressionStream(format) : new DecompressionStream(format),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function importCryptoKeys(clientKey) {
  return {
    aes: await crypto.subtle.importKey("raw", clientKey.subarray(0, 16), "AES-CTR", false, ["encrypt", "decrypt"]),
    hmac: await crypto.subtle.importKey(
      "raw",
      clientKey.subarray(16),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  };
}

async function processEncryptedResponsePart(partBytes, keys) {
  const fields = parseProto(partBytes);
  const ciphertext = firstProtoField(fields, 1, 2)?.value;
  const signature = firstProtoField(fields, 2, 2)?.value;
  const iv = firstProtoField(fields, 3, 2)?.value;
  const compression = firstProtoField(fields, 4, 0)?.value?.value ?? 0;
  if (!ciphertext || !signature || !iv || iv.length !== 16) throw new Error("Incomplete encrypted response part");
  if (compression !== 0 && compression !== 1) throw new Error(`Unsupported compression algorithm ${compression}`);

  const signedBytes = concatBytes(ciphertext, iv);
  const authentic = await crypto.subtle.verify("HMAC", keys.hmac, signature, signedBytes);
  if (!authentic) throw new Error("Encrypted response HMAC verification failed");

  const decrypted = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: iv, length: 128 },
    keys.aes,
    ciphertext,
  ));
  const clearBytes = compression === 1 ? await transformCompression(decrypted, "gzip", "decompress") : decrypted;
  const stripped = stripOnesieResponseAds(clearBytes);
  if (stripped.removed === 0 && stripped.enhanced === 0) {
    return { bytes: partBytes, removed: 0, enhanced: 0, changed: false };
  }

  const compressed = compression === 1 ? await transformCompression(stripped.bytes, "gzip", "compress") : stripped.bytes;
  const newIv = crypto.getRandomValues(new Uint8Array(16));
  const newCiphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: newIv, length: 128 },
    keys.aes,
    compressed,
  ));
  const newSignature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    keys.hmac,
    concatBytes(newCiphertext, newIv),
  ));

  return {
    bytes: replaceLengthDelimitedFields(partBytes, new Map([
      [1, newCiphertext],
      [2, newSignature],
      [3, newIv],
    ])),
    removed: stripped.removed,
    enhanced: stripped.enhanced,
    changed: true,
  };
}

async function processUmpResponse(bytes, clientKey) {
  const parts = parseUmp(bytes);
  const keys = await importCryptoKeys(clientKey);
  let nextDataIsEncryptedResponse = false;
  let removed = 0;
  let enhanced = 0;
  let changed = false;

  for (const part of parts) {
    if (part.type === 10) {
      const headerType = firstProtoField(parseProto(part.data), 1, 0)?.value?.value;
      nextDataIsEncryptedResponse = headerType === ENCRYPTED_INNERTUBE_RESPONSE;
      continue;
    }
    if (part.type !== 11 || !nextDataIsEncryptedResponse) continue;
    nextDataIsEncryptedResponse = false;

    try {
      const result = await processEncryptedResponsePart(part.data, keys);
      part.data = result.bytes;
      removed += result.removed;
      enhanced += result.enhanced;
      changed ||= result.changed;
    } catch (error) {
      console.error("YouTube encrypted response was left unchanged:", error);
    }
  }

  return {
    bytes: changed ? encodeUmp(parts) : bytes,
    removed,
    enhanced,
  };
}

function upstreamHeaders(requestHeaders) {
  const headers = new Headers(requestHeaders);
  for (const name of [
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-proto",
    "x-real-ip",
  ]) headers.delete(name);
  headers.set("accept-encoding", "identity");
  return headers;
}

function isAllowedGooglevideoTarget(target, paths) {
  return target.protocol === "https:"
    && GOOGLEVIDEO_HOST.test(target.hostname)
    && paths.has(target.pathname)
    && !target.port
    && !target.username
    && !target.password
    && !target.hash;
}

function hasAllowedFinalUpstreamUrl(upstream) {
  if (!upstream.url) return true;
  try {
    return isAllowedGooglevideoTarget(new URL(upstream.url), REDIRECTED_UPSTREAM_PATHS);
  } catch {
    return false;
  }
}

function responseHeaders(upstream, result, rewritten) {
  const headers = new Headers(upstream.headers);
  headers.delete("transfer-encoding");
  if (rewritten) {
    headers.delete("content-length");
    headers.delete("content-encoding");
  }
  headers.set("x-youtube-adblock", result);
  return headers;
}

function responseWithBytes(upstream, bytes, result) {
  return new Response(bytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream, result, true),
  });
}

function responseWithStream(upstream, result) {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream, result, false),
  });
}

async function handleRequest(request) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });

  const workerUrl = new URL(request.url);
  const targetValue = workerUrl.searchParams.get("target");
  const clientKeyValue = workerUrl.searchParams.get("ck");
  if (!targetValue || !clientKeyValue) return new Response("Missing target or ck", { status: 400 });
  if (clientKeyValue.length > MAX_CLIENT_KEY_CHARS) return new Response("Invalid ck", { status: 400 });

  let target;
  let clientKey;
  try {
    target = new URL(targetValue);
    clientKey = decodeBase64(clientKeyValue);
  } catch {
    return new Response("Invalid target or ck", { status: 400 });
  }
  if (!isAllowedGooglevideoTarget(target, INITIAL_UPSTREAM_PATHS)) {
    return new Response("Target Not Allowed", { status: 403 });
  }
  if (clientKey.length !== 32) return new Response("Invalid ck", { status: 400 });

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) return new Response("Request Too Large", { status: 413 });
  const requestBytes = new Uint8Array(await request.arrayBuffer());
  if (requestBytes.length > MAX_REQUEST_BYTES) return new Response("Request Too Large", { status: 413 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: upstreamHeaders(request.headers),
      body: requestBytes,
      // Keep Google's 307 initplayback transition inside Cloudflare. Returning
      // it to the app moves later videoplayback requests onto a different
      // network path and can invalidate the IP-bound stream URL with a 403.
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    clearTimeout(timeout);
    return new Response(timedOut ? "Upstream Timeout" : "Upstream Failed", {
      status: timedOut ? 504 : 502,
      headers: {"x-youtube-adblock": timedOut ? "bypass-timeout" : "bypass-fetch-error"},
    });
  }

  if (!hasAllowedFinalUpstreamUrl(upstream)) {
    clearTimeout(timeout);
    return new Response("Upstream Redirect Not Allowed", {
      status: 502,
      headers: {"x-youtube-adblock": "bypass-redirect-rejected"},
    });
  }

  const contentType = upstream.headers.get("content-type")?.toLowerCase() || "";
  if (!upstream.ok || !contentType.includes(UMP_CONTENT_TYPE)) {
    clearTimeout(timeout);
    return responseWithStream(upstream, "bypass-not-ump");
  }
  const responseLength = Number(upstream.headers.get("content-length") || 0);
  if (Number.isFinite(responseLength) && responseLength > MAX_RESPONSE_BYTES) {
    clearTimeout(timeout);
    return responseWithStream(upstream, "bypass-too-large");
  }

  let responseBytes;
  try {
    responseBytes = new Uint8Array(await upstream.arrayBuffer());
  } catch (error) {
    const timedOut = controller.signal.aborted;
    clearTimeout(timeout);
    return new Response(timedOut ? "Upstream Timeout" : "Upstream Read Failed", {
      status: timedOut ? 504 : 502,
      headers: {"x-youtube-adblock": timedOut ? "bypass-timeout" : "bypass-read-error"},
    });
  }
  clearTimeout(timeout);
  if (responseBytes.length > MAX_RESPONSE_BYTES) return responseWithBytes(upstream, responseBytes, "bypass-too-large");

  try {
    const result = await processUmpResponse(responseBytes, clientKey);
    return responseWithBytes(upstream, result.bytes, `removed-${result.removed}`);
  } catch (error) {
    console.error("YouTube UMP response was left unchanged:", error);
    return responseWithBytes(upstream, responseBytes, "bypass-error");
  }
}

export const __test = {
  decodeBase64,
  parseProto,
  parseUmp,
  processEncryptedResponsePart,
  processUmpResponse,
  stripOnesieResponseAds,
  stripNextResponseAds,
  stripPlayerAds,
};

export default {
  fetch: handleRequest,
};
