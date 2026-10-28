(() => {
  const endpoint = /^https:\/\/grpc\.biliapi\.net(?::443)?\/bilibili\.(?:app\.(?:(?:view|viewunite)\.v1\.View\/(?:View|ViewProgress|TFInfo|AIRelateAsync|RelatesFeed)|playerunite\.v1\.Player\/PlayViewUnite)|main\.community\.reply\.v[12]\.Reply\/(?:MainList|SubjectDescription))(?:\?.*)?$/;
  if ($request.method !== 'POST' || !endpoint.test($request.url || '')) return $done({});
  const input = $request.bodyBytes;
  const body = input instanceof ArrayBuffer ? new Uint8Array(input)
    : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!body || body.length < 5) return $done({});
  const headers = $request.headers || {};
  const type = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
  if (!/^application\/grpc(?:\+proto)?(?:;|$)/i.test(type)) return $done({});
  for (let at = 0; at < body.length;) {
    if (at + 5 > body.length || body[at] > 1) return $done({});
    const size = new DataView(body.buffer, body.byteOffset + at + 1, 4).getUint32(0);
    at += 5 + size;
    if (at > body.length) return $done({});
  }
  const output = Object.fromEntries(Object.entries(headers).filter(([key]) =>
    !/^(?:host|:authority|connection|te|trailer|transfer-encoding|content-length)$/i.test(key)));
  output.Host = 'app.bilibili.com';
  const url = $request.url.replace(/^https:\/\/grpc\.biliapi\.net(?::443)?\//, 'https://app.bilibili.com/');
  $done({ url, headers: output, bodyBytes: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
})();
