const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const file = fs.readFileSync(path.join(__dirname, '../Rewrite/Youtube/youtube.response.js'), 'utf8');
const start = file.indexOf('// Remove Sponsored cards from the captured Browse homepage');
const end = file.indexOf('// Remove the affiliate-product banner', start);
assert(start >= 0 && end > start);
const script = file.slice(start, end);
const varint = n => {const a=[]; do {let b=n%128;n=Math.floor(n/128);if(n)b|=128;a.push(b)} while(n);return Buffer.from(a)};
const field = (n,b) => Buffer.concat([varint(n*8+2),varint(b.length),b]);
const nest = (fields, body) => fields.reduceRight((b,n)=>field(n,b),body);
const card = content => field(1,field(50195462,field(999,Buffer.from(content))));
const prefix=[9,58173949,1,58174010,4,49399797];
const continuationPrefix=[10,49399797];
const wrap = (cards, layout=prefix) => nest(layout,Buffer.concat(cards));
function apply(input,url='https://youtubei.googleapis.com/youtubei/v1/browse') {
  const response={body:Uint8Array.from(input)};const context={$request:{url},$response:response,Uint8Array,console:{log(){}}};
  vm.runInNewContext(script,context,{timeout:5000});return Buffer.from(response.body);
}
test('removes only structurally identified sponsored cards while preserving organic siblings',()=>{
  const ordinary=card('organic recommendation');
  const meta=card('pagead adview sponsored-without-webview');
  const legacy=card('pagead yt-ads-web-view-id googleads');
  for(const ad of [meta,legacy]) {const input=wrap([ordinary,ad,ordinary]);const expected=wrap([ordinary,ordinary]);const output=apply(input);assert(output.equals(expected));assert(apply(output).equals(output));}
});
test('keeps lookalikes, unrelated pages and incomplete ad markers unchanged',()=>{
  for(const content of ['pagead','adview','pagead googleads','yt-ads-web-view-id googleads','ordinary Sponsored content']) {const input=wrap([card(content)]);assert(apply(input).equals(input));}
  const input=wrap([card('pagead adview')]);assert(apply(input,'https://youtubei.googleapis.com/youtubei/v1/player').equals(input));
  const truncated=input.subarray(0,input.length-2);assert(apply(truncated).equals(truncated));
});
test('continuation cards remove sponsored entries and keep organic siblings',()=>{
  const ordinary=card('organic recommendation'), ad=card('pagead adview sponsored-without-webview');
  const input=wrap([ordinary,ad,ordinary],continuationPrefix), expected=wrap([ordinary,ordinary],continuationPrefix);
  const output=apply(input);assert(output.equals(expected));assert(apply(output).equals(output));
});

function fullAdapter(input) {
  const marker='t=e.msgType.fromBinary(l.bodyBytes)';
  assert.equal(file.split(marker).length,2,'decoder hook must be unique');
  const instrumented=file.replace(marker,marker+',globalThis.__decodedInput=Array.from(l.bodyBytes),globalThis.__decoderSuccess=(globalThis.__decoderSuccess||0)+1');
  const original=Uint8Array.from(input).buffer, headers={'Content-Type':'application/x-protobuf','X-Fixture':'keep'};
  const savedHeaders={...headers}, outputs=[], logs=[], store=new Map();
  const ctx={$request:{url:'https://youtubei.googleapis.com/youtubei/v1/browse?continuation=fixture',method:'POST',headers:{}},
    $response:{statusCode:200,headers,bodyBytes:original},$environment:{},
    $prefs:{valueForKey:k=>store.get(k),setValueForKey:(v,k)=>(store.set(k,v),true),removeValueForKey:k=>store.delete(k)},
    $task:{fetch:()=>{throw Error('unexpected network');}},$done:v=>outputs.push(v),
    console:{log:x=>logs.push(String(x))},setTimeout,clearTimeout,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,URL,atob,btoa};
  vm.runInNewContext(instrumented,ctx,{timeout:5000});
  assert.equal(outputs.length,1,'$done must be called exactly once');
  assert.deepEqual(headers,savedHeaders,'input headers must not change');
  assert.equal(outputs[0].headers,undefined,'response must not replace headers');
  assert.equal(ctx.__decoderSuccess,1,'downstream Browse protobuf decoder must succeed: '+logs.join('; '));
  const body=outputs[0].bodyBytes===undefined?Buffer.from(original):Buffer.from(outputs[0].bodyBytes);
  if(outputs[0].bodyBytes!==undefined) assert(outputs[0].bodyBytes instanceof ArrayBuffer);
  return {body,logs,output:outputs[0],decodedInput:Buffer.from(ctx.__decodedInput)};
}

for(const [name,layout] of [['homepage',prefix],['continuation',continuationPrefix]]) {
  test(`full adapter filters ${name} and preserves protobuf and organic cards`,()=>{
    const ordinary=card('organic recommendation'), ad=card('pagead adview sponsored-without-webview');
    const input=wrap([ordinary,ad,ordinary],layout), expected=wrap([ordinary,ordinary],layout);
    const result=fullAdapter(input);assert(result.body.equals(expected));assert(result.decodedInput.equals(expected));assert(result.output.bodyBytes instanceof ArrayBuffer);
    assert(fullAdapter(result.body).body.equals(expected));
  });
}
test('full adapter keeps organic-only continuation and input headers unchanged',()=>{
  const input=wrap([card('organic one'),card('organic two')],continuationPrefix);
  const result=fullAdapter(input);assert(result.body.equals(input));assert(result.decodedInput.equals(input));
});
test('private HAR replay removes the captured sponsored card and retains every organic sibling',{skip:!process.env.YT_FEED_HAR},()=>{
  const entries=JSON.parse(fs.readFileSync(process.env.YT_FEED_HAR,'utf8')).log.entries;
  const entry=entries.find(e=>{const c=e.response?.content||{};return e.request.url.includes('/youtubei/v1/browse')&&c.encoding==='base64'&&Buffer.from(c.text||'','base64').includes(Buffer.from('Muse from Meta'));});
  assert(entry);const input=Buffer.from(entry.response.content.text,'base64');const output=apply(input);assert(!output.includes(Buffer.from('Muse from Meta')));assert(output.length<input.length);assert(apply(output).equals(output));
  function read(b,i){let v=0,m=1;for(let k=0;k<10;k++){const x=b[i++];v+=(x&127)*m;if(!(x&128))return[v,i];m*=128;}throw Error('varint');}
  function parse(b){let i=0,arr=[];while(i<b.length){let t;[t,i]=read(b,i);let w=t%8,n=Math.floor(t/8);if(w===2){let len;[len,i]=read(b,i);arr.push([n,b.subarray(i,i+len)]);i+=len;}else if(w===0){[,i]=read(b,i)}else if(w===1)i+=8;else if(w===5)i+=4;else throw Error('wire');}return arr;}
  const cards=b=>{for(const n of prefix)b=parse(b).find(f=>f[0]===n)[1];return parse(b).filter(f=>f[0]===1).map(f=>f[1]);};
  const before=cards(input),after=cards(output),organic=before.filter(x=>!x.includes(Buffer.from('Muse from Meta')));assert.equal(after.length,organic.length);for(let i=0;i<after.length;i++)assert(after[i].equals(organic[i]));
  const full=fullAdapter(input);assert(!full.body.includes(Buffer.from('Muse from Meta')));assert(full.decodedInput.equals(output));
  const actual=cards(full.body);assert.equal(actual.length,organic.length);for(let i=0;i<actual.length;i++)assert(actual[i].equals(organic[i]));
});
