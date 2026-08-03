/**
 * Yahoo Finance AdBlock for Quantumult X.
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
