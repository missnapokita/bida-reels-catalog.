import test from 'node:test';
import assert from 'node:assert/strict';
import providers from '../src/providers.mjs';
import {directRequest,providerPayload,fetchProvider,directoryId} from '../src/provider-source.mjs';
import {CatalogCoordinator} from '../src/index.mjs';

const provider=key=>providers.find(p=>p.key===key);
test('documented header providers receive x-token and keep credentials out of the URL',()=>{
  for(const key of ['dramabox','bonustv']) {
    const p=provider(key),r=directRequest(p,p.feeds[0],1,'fixture-access');
    assert.equal(r.headers['x-token'],'fixture-access');assert.equal(new URL(r.url).searchParams.get('code'),null);
    assert.equal(r.redirect,'error');assert.equal(r.headers.Authorization,undefined);
  }
});
test('direct query transport preserves language, filters and the requested page',()=>{
  const p=provider('happyshort'),r=directRequest(p,p.feeds[0],3,'fixture-access'),url=new URL(r.url);
  assert.equal(url.origin,p.root);assert.equal(url.searchParams.get('code'),'fixture-access');
  assert.equal(url.searchParams.get('page'),'3');assert.equal(url.searchParams.get('lang'),'en');
  assert.equal(r.headers.Authorization,undefined);
});
test('ReelShort uses the documented shelf rather than an invented latest route',()=>{
  const p=provider('reelshort'),url=new URL(directRequest(p,p.feeds[0],4,'fixture-access').url);
  assert.equal(url.pathname,'/shelf/2009269');assert.equal(url.searchParams.get('page'),'4');
});
test('direct requests reject cross-origin and insecure paths',()=>{
  const p=provider('happyshort');
  for(const path of ['//evil.test/catalog','https://evil.test/catalog'])
    assert.throws(()=>directRequest(p,{path},1,'fixture-access'),/Invalid provider/);
  assert.throws(()=>directRequest({...p,root:'http://insecure.test'},p.feeds[0],1,'fixture-access'),/Invalid provider/);
});
test('direct payload keeps outer pagination and exact long IDs',()=>{
  const value=providerPayload('{"data":[{"id":2004076783771176960}],"total_pages":25,"has_next":true}',200);
  assert.equal(value.data[0].id,'2004076783771176960');assert.equal(value.total_pages,25);assert.equal(value.has_next,true);
  assert.equal(providerPayload('{"code":0,"data":[]}',200).code,0);
});
test('provider errors are rejected even if the HTTP response says 200',()=>{
  for(const body of [{success:false},{status:false},{status:'error'},{code:401},{data:{success:false}}])
    assert.throws(()=>providerPayload(JSON.stringify(body),200),error=>error.feedFailure&&error.retryable);
  assert.throws(()=>providerPayload('<html>unavailable</html>',502),error=>error.feedFailure&&error.retryable);
  assert.throws(()=>providerPayload('{}',429),error=>error.retryable);
  assert.throws(()=>providerPayload('{}',404),error=>!error.retryable);
});
test('direct fetch retries bypass intermediate caches without sending a user bearer token',async()=>{
  const original=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url,options};return new Response('{"data":[],"hasMore":false}',{status:200});};
  try {
    const p=provider('starshort');await fetchProvider(p,p.feeds[0],2,{PROVIDER_ACCESS_CODE:'fixture-access'},'',1);
    assert.equal(seen.options.headers['Cache-Control'],'no-cache');assert.equal(seen.options.headers.Authorization,undefined);
    assert.equal(seen.options.redirect,'error');assert.equal(new URL(seen.url).searchParams.get('p'),'2');
  } finally {globalThis.fetch=original;}
});

class Storage {
  constructor(){this.map=new Map();}
  async get(key){return structuredClone(this.map.get(key));}
  async put(key,value){this.map.set(key,structuredClone(value));}
  async list({prefix}={}){return new Map([...this.map].filter(([key])=>!prefix||key.startsWith(prefix)));}
  async setAlarm(value){this.alarm=value;}
}
const setup=env=>{const storage=new Storage();return {storage,c:new CatalogCoordinator({storage,blockConcurrencyWhile:fn=>fn()},env||{})};};
test('directory aliases match the IDs actually reported by the status API',()=>{
  assert.equal(directoryId('plerplow'),'flareflow');assert.equal(directoryId('shortwave'),'shortswave');assert.equal(directoryId('dramabox'),'dramabox');
});
test('maintenance providers are skipped without touching their last published metadata',async()=>{
  const {c,storage}=setup();c.providerDirectory=async()=>({kalostv:'maintenance',dramabox:'active'});
  await storage.put('meta:kalostv',{version:'saved',count:20});
  const r=await c.fetch(new Request('https://internal/queue',{method:'POST',body:JSON.stringify({keys:['kalostv','dramabox'],mode:'check',sessionId:'fixture-session'})}));
  assert.equal((await r.json()).queued,1);assert.equal((await storage.get('status:kalostv')).state,'maintenance');
  assert.equal((await storage.get('meta:kalostv')).version,'saved');assert.deepEqual((await storage.get('queue')).map(q=>q.key),['dramabox']);
});
test('status polling is disabled without the server secret and coalesced when configured',async()=>{
  assert.equal(await setup().c.providerDirectory(),null);
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({success:true,platforms:[{id:'kalostv',status:'maintenance'}]}));};
  try {
    const {c}=setup({PROVIDER_ACCESS_CODE:'fixture-access'});
    const results=await Promise.all([c.providerDirectory(),c.providerDirectory(),c.providerDirectory()]);
    assert.equal(results[0].kalostv,'maintenance');assert.equal((await c.providerDirectory()).kalostv,'maintenance');assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});
test('missing direct secret preserves the existing authenticated gateway mode',async()=>{
  const original=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url,options};return new Response('{"success":true,"data":{"items":[]}}');};
  try {
    const {c}=setup({UPSTREAM_GATEWAY:'https://gateway.test'});c.token=async()=> 'fixture-user-token';
    const p=provider('happyshort');await c.upstream(p,p.feeds[0],1,'fixture-session');
    assert.equal(new URL(seen.url).origin,'https://gateway.test');assert.equal(seen.options.headers.Authorization,'Bearer fixture-user-token');
    assert.equal(new URL(seen.url).searchParams.has('code'),false);
  } finally {globalThis.fetch=original;}
});
