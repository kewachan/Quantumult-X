(() => {
  const body = $response.body;
  if (Number($response.statusCode || 200) !== 200 || typeof body !== 'string') return $done({});
  const play = 'play(a,u,m){this.#t=a,this.#i=u,this.#e=m,this.#u={},this.#o=!1,this.#l=[],this.#d()}';
  const destroy = 'destroy(){this.#s&&this.#s.destroy(),this.#a&&this.#a.destroy(),this.#r&&this.#r.destroy(),this.#n&&this.#n.destroy()}';
  if (body.split(play).length !== 2 || body.split(destroy).length !== 2) return $done({});
  const replacement = `play(a,u,m){
    this.#t=a;this.#i=u;this.#e=m;this.#u={};this.#o=false;this.#l=[];
    if(!u.enableAd){m();return}
    const state={controller:new AbortController(),timer:null};
    this.qxWebAdValidation=state;this.#E(Ai.SHOW);
    const endpoint='/ajax/videoCastcishu.php?s='+encodeURIComponent(u.adSid)+'&sn='+encodeURIComponent(a);
    const active=()=>this.qxWebAdValidation===state&&!state.controller.signal.aborted;
    const request=url=>fetch(url,{signal:state.controller.signal}).then(response=>{if(!response.ok)throw Error('Playback validation HTTP '+response.status)});
    request(endpoint).then(()=>new Promise(resolve=>{if(active())state.timer=setTimeout(resolve,31000)}))
      .then(()=>{if(!active())return;return request(endpoint+'&ad=end')})
      .then(()=>{if(active()){this.qxWebAdValidation=null;m()}})
      .catch(()=>{if(active()){this.qxWebAdValidation=null;this.#d()}})
  }`;
  const cleanup = 'destroy(){if(this.qxWebAdValidation){this.qxWebAdValidation.controller.abort();clearTimeout(this.qxWebAdValidation.timer);this.qxWebAdValidation=null}' + destroy.slice('destroy(){'.length);
  $done({ body: body.replace(play, replacement).replace(destroy, cleanup) });
})();
