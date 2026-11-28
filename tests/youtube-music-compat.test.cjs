const assert = require('node:assert/strict');
const {test, before} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
let worker, workerTest;
before(async () => {
  const source = fs.readFileSync(path.join(root, 'Rewrite/Youtube/youtube.worker.js'));
  const loaded = await import(`data:text/javascript;base64,${Buffer.concat([Buffer.from('const console={error(){}};\n'),source]).toString('base64')}`);
  worker = loaded.default; workerTest = loaded.__test;
});
const vi = n => { const a=[]; do { let b=n%128; n=Math.floor(n/128); if(n)b|=128; a.push(b); } while(n); return Buffer.from(a); };
const field = (n,b) => Buffer.concat([vi(n*8+2),vi(b.length),b]);
const scalar = (n,v) => Buffer.concat([vi(n*8),vi(v)]);
function ump(type,b) { assert(b.length < 16384); return Buffer.concat([Buffer.from([type]), b.length < 128 ? Buffer.from([b.length]) : Buffer.from([0x80|b.length%64,Math.floor(b.length/64)]), b]); }
function fixture() {
  const key=Buffer.alloc(32,7), iv=Buffer.alloc(16,3);
  const track=Buffer.concat([field(1,Buffer.from('https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en')),field(4,Buffer.from('en'))]);
  const player=Buffer.concat([field(10,field(51621377,field(1,track))),field(7,Buffer.from('advertisement')),field(198,Buffer.from('keep'))]);
  const clear=field(4,Buffer.concat([field(2,player),scalar(7,0),scalar(10,0)]));
  const cipher=crypto.createCipheriv('aes-128-ctr',key.subarray(0,16),iv);
  const encrypted=Buffer.concat([cipher.update(zlib.gzipSync(clear)),cipher.final()]);
  const sig=crypto.createHmac('sha256',key.subarray(16)).update(Buffer.concat([encrypted,iv])).digest();
  const metadata=Buffer.concat([ump(10,scalar(1,25)),ump(11,Buffer.concat([field(1,encrypted),field(2,sig),field(3,iv),scalar(4,1)]))]);
  return {key,metadata,audio:ump(21,Buffer.from('audio-unchanged'))};
}
async function transform(body,key,lang='zh-Hant') {
  return worker.fetch(new Request('https://worker.test/transform?ck='+encodeURIComponent(key.toString('base64'))+'&captionLang='+lang,
    {method:'POST',headers:{'Content-Type':'application/vnd.yt-ump'},body}));
}
async function runClient(f, failure=false, config={}) {
  const source=fs.readFileSync(path.join(root,'Rewrite/Youtube/youtube.init.response.js'),'utf8');
  const input=Buffer.concat([f.metadata,f.audio]); let calls=0, done=0;
  return new Promise((resolve,reject) => {
    const store=config.store || new Map([['YouTubePlaybackKeys.v2.youtubeMusic',JSON.stringify({entries:[{clientKey:f.key.toString('base64'),expiresAt:Date.now()+60000}]})]]);
    const ctx={Uint8Array,ArrayBuffer,DataView,Date,Math,JSON,console:{log(){}},setTimeout,clearTimeout,
      $request:{headers:{'User-Agent':config.agent || 'YouTubeMusic'}},$response:{statusCode:200,headers:{'content-type':'application/vnd.yt-ump'},bodyBytes:Uint8Array.from(input).buffer},
      $prefs:{valueForKey:key=>store.get(key),setValueForKey:(value,key)=>(store.set(key,value),true)},
      $task:{fetch:async req=>{calls++;if(failure==='network')throw Error('unavailable');if(failure==='status')return {statusCode:503,headers:{},bodyBytes:new ArrayBuffer(0)};const res=await transform(new Uint8Array(req.bodyBytes),f.key);return {statusCode:res.status,headers:Object.fromEntries(res.headers),bodyBytes:await res.arrayBuffer()};}},
      $done(value){done++;resolve({value,calls,done,input});}};
    try { vm.runInNewContext(source,ctx); } catch(e) {reject(e);}
  });
}
test('single response rule preserves ack and scopes Music startup and SABR',()=>{
  const lines=fs.readFileSync(path.join(root,'Rewrite/Youtube/YouTube.Enhance.list'),'utf8').split('\n').filter(x=>x.includes('youtube.init.response.js'));
  assert.equal(lines.length,1); const re=new RegExp(lines[0].split(' url ')[0]);
  for(const [p,q,yes] of [['initplayback','ack=1&c=IOS',true],['initplayback','c=IOS_MUSIC',true],['initplayback','x=1&c=IOS_MUSIC&ack=1',true],['videoplayback','c=IOS_MUSIC&sabr=1',true],['videoplayback','sabr=1&c=IOS_MUSIC',true],['videoplayback','sabr=0&c=IOS_MUSIC',false],['videoplayback','sabr=1&c=IOS',false],['videoplayback','xsabr=1&c=IOS_MUSIC',false],['initplayback','notack=1&c=IOS',false]]) assert.equal(re.test(`https://r1.googlevideo.com/${p}?${q}`),yes,`${p}?${q}`);
  assert(!re.test('https://r1.googlevideo.com.evil.test/initplayback?ack=1'));
});
test('worker transforms encrypted metadata and leaves audio untouched through QX adapter',async()=>{
  const f=fixture(), result=await runClient(f); assert.equal(result.done,1); assert.equal(result.calls,1); assert(result.value.bodyBytes);
  const output=Buffer.from(result.value.bodyBytes); assert(output.subarray(-f.audio.length).equals(f.audio));
  const part=workerTest.parseUmp(output).find(p=>p.type===11);
  const fields=workerTest.parseProto(part.data), cipher=fields.find(p=>p.no===1).value, iv=fields.find(p=>p.no===3).value;
  const decrypt=crypto.createDecipheriv('aes-128-ctr',f.key.subarray(0,16),iv);
  const clear=zlib.gunzipSync(Buffer.concat([decrypt.update(cipher),decrypt.final()]));
  assert(clear.includes(Buffer.from('tlang=zh-Hant'))); assert(!clear.includes(Buffer.from('advertisement'))); assert(clear.includes(Buffer.from('keep')));
  const second=await transform(output.subarray(0,-f.audio.length),f.key); assert.equal(second.headers.get('x-youtube-adblock'),'removed-0');
  assert(Buffer.from(await second.arrayBuffer()).equals(output.subarray(0,-f.audio.length)));
});
test('disabled caption translation does not add a track',async()=>{
  const f=fixture(), response=await transform(f.metadata,f.key,'off');
  const part=workerTest.parseUmp(new Uint8Array(await response.arrayBuffer())).find(p=>p.type===11);
  const fields=workerTest.parseProto(part.data), cipher=fields.find(p=>p.no===1).value, iv=fields.find(p=>p.no===3).value;
  const decrypt=crypto.createDecipheriv('aes-128-ctr',f.key.subarray(0,16),iv);
  const clear=zlib.gunzipSync(Buffer.concat([decrypt.update(cipher),decrypt.final()]));
  assert(!clear.includes(Buffer.from('tlang='))); assert(clear.includes(Buffer.from('lang=en')));
});
test('worker and QX adapter preserve original playback on failures',async()=>{
  const f=fixture(); for(const fault of ['network','status']) {const result=await runClient(f,fault); assert.equal(result.done,1); assert.deepEqual(Object.keys(result.value),[]);}
  const invalid=await transform(Uint8Array.of(255),f.key); assert.equal(invalid.headers.get('x-youtube-adblock'),'bypass-error'); assert.deepEqual(Buffer.from(await invalid.arrayBuffer()),Buffer.from([255]));
  const wrong=await transform(f.metadata,Buffer.alloc(32,8)); assert.equal(wrong.headers.get('x-youtube-adblock'),'removed-0'); assert(Buffer.from(await wrong.arrayBuffer()).equals(f.metadata));
  const badType=await worker.fetch(new Request('https://worker.test/transform?ck=x',{method:'POST',body:'x'})); assert.equal(badType.status,415);
});
async function runBootstrap({agent='com.google.ios.youtube/20', key=Buffer.alloc(32,7), fault='', requestBody, store=new Map(), session=123}={}) {
  const source=fs.readFileSync(path.join(root,'Rewrite/Youtube/youtube.bootstrap.request.js'),'utf8');
  const context=field(1,Buffer.from('synthetic-context')), body=requestBody||Buffer.concat([context,field(2,Buffer.from('private-not-forwarded'))]);
  const hot=Buffer.concat([field(1,key),field(2,Buffer.alloc(128,9)),scalar(3,120)]);
  const config=[1,16,7,138536474,146311580].reduceRight((b,n)=>field(n,b),hot);
  let calls=[],count=0; const started=Date.now();
  return new Promise((resolve,reject)=>{
    const ctx={Uint8Array,ArrayBuffer,DataView,Date,Math,JSON,console:{log(){}},setTimeout,clearTimeout,
      $request:{method:'POST',url:'https://youtubei.googleapis.com/youtubei/v1/mdx/handoff',sessionIndex:session,headers:{'user-agent':agent,'content-type':'application/x-protobuf','x-youtube-hot-hash-data':'synthetic'},bodyBytes:Uint8Array.from(body).buffer},
      $prefs:{valueForKey:k=>store.get(k),setValueForKey:(v,k)=>(store.set(k,v),true)},
      $task:{fetch:req=>{calls.push(req);if(fault==='timeout')return new Promise(()=>{});if(fault==='network')return Promise.reject(Error('offline'));if(fault==='invalid')return Promise.resolve({statusCode:200,headers:{'content-type':'application/x-protobuf'},bodyBytes:Uint8Array.of(255).buffer});return Promise.resolve({statusCode:200,headers:{'content-type':'application/x-protobuf'},bodyBytes:Uint8Array.from(config).buffer});}},
      $done(value){count++;resolve({value,count,calls,store,body,context,elapsed:Date.now()-started});}};
    try {vm.runInNewContext(source,ctx);} catch(e){reject(e);}
  });
}
test('YouTube bootstrap obtains context-only key and encrypted playback uses it',async()=>{
  const f=fixture(), r=await runBootstrap({key:f.key});assert.equal(r.count,1);assert.deepEqual(Object.keys(r.value),[]);assert.equal(r.calls.length,1);
  assert(Buffer.from(r.calls[0].bodyBytes).equals(r.context));assert(!Object.keys(r.calls[0].headers).some(k=>k.toLowerCase()==='x-youtube-hot-hash-data'));
  assert(r.store.has('YouTubePlaybackKeys.v2.youtube'));assert(!r.store.has('YouTubePlaybackKeys.v2.youtubeMusic'));
  const result=await runClient(f,false,{agent:'com.google.ios.youtube/20',store:r.store});assert(result.value.bodyBytes);assert(Buffer.from(result.value.bodyBytes).subarray(-f.audio.length).equals(f.audio));
});
test('YouTube bootstrap failures and deadline leave request and stored keys alone',async()=>{
  for(const fault of ['network','invalid','timeout']) {const r=await runBootstrap({fault});assert.equal(r.count,1);assert.deepEqual(Object.keys(r.value),[]);assert.equal(r.calls.length,1);assert(!r.store.has('YouTubePlaybackKeys.v2.youtube'));if(fault==='timeout')assert(r.elapsed<1400);}
});
test('Music bootstrap remains separate and unknown agents bypass it',async()=>{
  const music=await runBootstrap({agent:'com.google.ios.youtubemusic/8'});assert(music.store.has('YouTubeHotConfigBootstrap.v1.youtubeMusic'));assert(!music.store.has('YouTubePlaybackKeys.v2.youtube'));
  const other=await runBootstrap({agent:'unrelated-client'});assert.equal(other.calls.length,0);assert.equal(other.count,1);
});
test('private YouTube HAR handoffs trigger bounded context-only bootstrap', {skip:!process.env.YT_STARTUP_HAR}, async()=>{
  const entries=JSON.parse(fs.readFileSync(process.env.YT_STARTUP_HAR,'utf8')).log.entries;
  const handoffs=entries.filter(e=>{const u=new URL(e.request.url);return u.hostname==='youtubei.googleapis.com'&&u.pathname==='/youtubei/v1/mdx/handoff'&&e.request.postData?.encoding==='base64';});
  assert(handoffs.length>0);
  for(const e of handoffs){const agent=e.request.headers.find(h=>h.name.toLowerCase()==='user-agent')?.value||'';const body=Buffer.from(e.request.postData.text,'base64');const r=await runBootstrap({agent,requestBody:body});assert.equal(r.calls.length,1);assert(r.store.has('YouTubePlaybackKeys.v2.youtube'));assert(Buffer.from(r.calls[0].bodyBytes).length<body.length);}
});
