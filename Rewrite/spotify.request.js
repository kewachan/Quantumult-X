(() => {
  const pattern = /^https:\/\/(?:\w+-spclient|spclient\.wg)\.spotify\.com(?::443)?\/artistview\/v1\/artist\/(.*)&platform=iphone/;
  const url = $request.url.replace(pattern, "https://spclient.wg.spotify.com/artistview/v1/artist/$1&platform=ipad");
  $done(url === $request.url ? {} : { url });
})();
