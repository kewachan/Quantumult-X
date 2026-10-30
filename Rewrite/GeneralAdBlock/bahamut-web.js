(() => {
  const body = $response.body;
  if (!/^https:\/\/i2\.bahamut\.com\.tw\/build\/js\/anime_player\.js(?:\?[^#]*)?$/.test($request.url || '')
    || Number($response.statusCode || 200) !== 200 || typeof body !== 'string') return $done({});
  const play = 'play(a,u,m){this.#t=a,this.#i=u,this.#e=m,this.#u={},this.#o=!1,this.#l=[],this.#d()}';
  const destroy = 'destroy(){this.#s&&this.#s.destroy(),this.#a&&this.#a.destroy(),this.#r&&this.#r.destroy(),this.#n&&this.#n.destroy()}';
  // Tolerate formatting changes only. Unknown symbols or logic retain the original player.
  const methods = source => {
    const tokens = source.match(/#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*|&&|[^\s]/g);
    const pattern = tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    return [...body.matchAll(new RegExp('\\b' + pattern, 'g'))];
  };
  const plays = methods(play), destroys = methods(destroy);
  if (plays.length !== 1 || destroys.length !== 1) return $done({});
  const replacement = `play(a,u,m){
    if(this.qxWebAdValidation){
      const previous=this.qxWebAdValidation;this.qxWebAdValidation=null;
      previous.controller.abort();clearTimeout(previous.timer);clearTimeout(previous.timeout);
    }
    this.#t=a;this.#i=u;this.#e=m;this.#u={};this.#o=false;this.#l=[];
    if(!u.enableAd){m();return}
    if(typeof fetch!=='function'||typeof AbortController!=='function'
      ||!(['string','number'].includes(typeof u.adSid))||String(u.adSid).trim()===''
      ||typeof u.adSid==='number'&&!Number.isFinite(u.adSid)){this.#d();return}
    const state={controller:new AbortController(),timer:null,timeout:null};
    this.qxWebAdValidation=state;this.#E(Ai.SHOW);
    const endpoint='/ajax/videoCastcishu.php?s='+encodeURIComponent(u.adSid)+'&sn='+encodeURIComponent(a);
    const active=()=>this.qxWebAdValidation===state&&!state.controller.signal.aborted;
    const request=url=>{
      let timer;
      return Promise.race([
        Promise.resolve().then(()=>fetch(url,{signal:state.controller.signal}))
          .then(response=>{if(!response.ok)throw Error('Playback validation HTTP '+response.status)}),
        new Promise((resolve,reject)=>{state.timeout=timer=setTimeout(()=>reject(Error('Playback validation timeout')),10000)})
      ]).finally(()=>{clearTimeout(timer);if(state.timeout===timer)state.timeout=null})
    };
    request(endpoint).then(()=>new Promise(resolve=>{if(active())state.timer=setTimeout(resolve,31000)}))
      .then(()=>{if(!active())return;return request(endpoint+'&ad=end')})
      .then(()=>{if(active()){this.qxWebAdValidation=null;m()}})
      .catch(()=>{if(active()){
        this.qxWebAdValidation=null;state.controller.abort();clearTimeout(state.timer);clearTimeout(state.timeout);this.#d()
      }})
  }`;
  const originalDestroy = destroys[0][0];
  const cleanup = 'destroy(){if(this.qxWebAdValidation){const state=this.qxWebAdValidation;this.qxWebAdValidation=null;state.controller.abort();clearTimeout(state.timer);clearTimeout(state.timeout)}'
    + originalDestroy.slice(originalDestroy.indexOf('{') + 1);
  let output = body;
  for (const [match, value] of [[plays[0], replacement], [destroys[0], cleanup]].sort((a, b) => b[0].index - a[0].index)) {
    output = output.slice(0, match.index) + value + output.slice(match.index + match[0].length);
  }
  $done({ body: output });
})();
