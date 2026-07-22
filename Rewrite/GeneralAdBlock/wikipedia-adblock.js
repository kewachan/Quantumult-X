let body = $response.body || "";
const url = $request.url || "";

const isVariantDialog =
  /https?:\/\/zh\.wikipedia\.org\/w\/load\.php/i.test(url) &&
  /(?:[?&]|%26)modules=ext\.gadget\.VariantAllyDialog(?:[&%]|$)/i.test(url);

const isCentralNotice =
  /https?:\/\/meta\.wikimedia\.org\/w\/index\.php/i.test(url) &&
  /(?:[?&]|%26)title=Special(?::|%3A)BannerLoader(?:[&%]|$)/i.test(url);

const isAdvancedSiteNotices =
  /https?:\/\/zh\.wikipedia\.org\/w\/api\.php/i.test(url) &&
  /(?:[?&]|%26)page=Template(?::|%3A)AdvancedSiteNotices(?:\/|%2F)ajax(?:[&%]|$)/i.test(url);

if (isVariantDialog || isCentralNotice) {
  body = "";
} else if (isAdvancedSiteNotices && body) {
  try {
    const json = JSON.parse(body);
    if (json.parse && typeof json.parse === "object") {
      json.parse.text = "";
      body = JSON.stringify(json);
    }
  } catch (error) {
    // Preserve an unexpected response instead of breaking the page.
  }
}

$done({ body });
