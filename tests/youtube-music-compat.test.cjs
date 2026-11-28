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
async function runClient(f, failure=false) {
  const source=fs.readFileSync(path.join(root,'Rewrite/Youtube/youtube.init.response.js'),'utf8');
  const input=Buffer.concat([f.metadata,f.audio]); let calls=0, done=0;
  return new Promise((resolve,reject) => {
    const store=JSON.stringify({entries:[{clientKey:f.key.toString('base64'),expiresAt:Date.now()+60000}]});
    const ctx={Uint8Array,ArrayBuffer,DataView,Date,Math,JSON,console:{log(){}},setTimeout,clearTimeout,
      $request:{headers:{'User-Agent':'YouTubeMusic'}},$response:{statusCode:200,headers:{'content-type':'application/vnd.yt-ump'},bodyBytes:Uint8Array.from(input).buffer},
      $prefs:{valueForKey:()=>store,setValueForKey:()=>true},
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
