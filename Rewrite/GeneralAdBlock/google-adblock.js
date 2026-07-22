/**
 * Google AdBlock for Surge
 *
 * Directly hides ad containers in Google Search HTML responses.
 */

let body = $response.body || "";
const isGoogleSearch = /https?:\/\/(www\.)?google\.[^/]+\/search/i.test($request.url);
const isPaginationResponse = /[?&](?:asearch=arc|async=arc_id(?::|%3A))/i.test($request.url);
const sponsoredStyle = 'style="display:none!important"';

function addSponsoredStyle(tag) {
  if (/style=(['"])[^'"]*display\s*:\s*none/i.test(tag)) {
    return tag;
  }

  if (/style=(['"])/i.test(tag)) {
    return tag.replace(/style=(['"])([^'"]*)\1/i, function(_, quote, style) {
      return "style=" + quote + "display:none!important;" + style + quote;
    });
  }

  return tag.replace(/>$/, " " + sponsoredStyle + ">");
}

function isSponsoredTag(tag) {
  return /\bid=(['"])tads\1/i.test(tag) ||
    /\bjscontroller=(['"])tY2w9d\1/i.test(tag) ||
    /\bjsname=(['"])ix0Hvc\1/i.test(tag) ||
    /\bdata-text-ad=(['"])1\1/i.test(tag);
}

function hideSponsoredHtml(html) {
  const hasSponsoredContent = /Sponsored result/i.test(html) ||
    /\bid=(['"])tads\1/i.test(html) ||
    /\bdata-text-ad=(['"])1\1/i.test(html);
  if (!hasSponsoredContent) {
    return html;
  }

  return html.replace(/<[a-z][^>]*>/gi, function(tag) {
    return isSponsoredTag(tag) ? addSponsoredStyle(tag) : tag;
  });
}

function rewriteArcResponse(text) {
  const prefix = text.startsWith(")]}'\n") ? ")]}'\n" : "";
  let position = prefix.length;
  let output = prefix;

  while (position < text.length) {
    const header = text.slice(position).match(/^([0-9a-f]+);/i);
    if (!header) {
      return null;
    }

    const length = parseInt(header[1], 16);
    const start = position + header[0].length;
    const end = start + length;
    if (end > text.length) {
      return null;
    }

    const payload = hideSponsoredHtml(text.slice(start, end));
    output += payload.length.toString(16) + ";" + payload;
    position = end;
  }

  return output;
}

if (isGoogleSearch && isPaginationResponse) {
  const rewritten = rewriteArcResponse(body);
  if (rewritten !== null && rewritten !== body) {
    $done({ body: rewritten });
  } else {
    $done({});
  }
} else if (isGoogleSearch) {
  // Known working response replacement for the Google app promotion.
  if (body.includes("Ask and explore anything with the Google app")) {
    body = body
      .replaceAll(
        'class=\\"B2VR9 CJHX3e\\"',
        'class=\\"B2VR9 CJHX3e\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="B2VR9 CJHX3e"',
        'class="B2VR9 CJHX3e" style="display:none!important"'
      )
      .replaceAll(
        'class=\\"CJHX3e B2VR9\\"',
        'class=\\"CJHX3e B2VR9\\" style=\\"display:none!important\\"'
      )
      .replaceAll(
        'class="CJHX3e B2VR9"',
        'class="CJHX3e B2VR9" style="display:none!important"'
      );
  }

  // Hide the complete Sponsored Result header and content without leaving gaps.
  body = hideSponsoredHtml(body);
  $done({ body: body });
} else {
  $done({});
}
