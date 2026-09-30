import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJSON,normalize,pagePath,pagination,mergeItems,digest} from '../src/catalog.mjs';
import {CatalogCoordinator} from '../src/index.mjs';
import providers from '../src/providers.mjs';
const p=providers.find(p=>p.key==='dramabox');
test('long IDs remain exact, numeric text inside strings is untouched',()=>{
 const value=parseJSON('{"id":2004076783771176960,"title":"2004076783771176960","value":3}');
 assert.equal(value.id,'2004076783771176960');assert.equal(value.title,value.id);assert.equal(value.value,3);
});
test('allowlist strips media links, credentials, and unrelated provider payload',()=>{
 const result=normalize({data:[{bookId:'9',bookName:'Hello',cover:'https://img.test/a.jpg',chapterCount:40,videoUrl:'https://test/secret.m3u8',token:'secret',episodes:[{url:'secret'}]}]},p,'latest');
 assert.equal(result.length,1);assert.equal(result[0].episodes,40);assert.deepEqual(Object.keys(result[0]).sort(),['description','episodes','feeds','genre','id','posterUrl','title']);
});
test('merge updates episode count and retains section membership by ID',()=>{
 const result=mergeItems([{id:'9',episodes:2,feeds:['latest']}],[{id:'9',episodes:3,feeds:['trending']}]);
 assert.equal(result.length,1);assert.equal(result[0].episodes,3);assert.deepEqual(result[0].feeds,['latest','trending']);
});
test('known provider paths advance query pagination correctly',()=>{
 const free=providers.find(p=>p.key==='freereels');const query=new URL('https://test'+pagePath(free,free.feeds[0],4));assert.match(query.searchParams.get('path'),/page=4/);
 const net=providers.find(p=>p.key==='netshort');assert.match(new URL('https://test'+pagePath(net,net.feeds[0],3)).searchParams.get('path'),/\/home\/3/);
 assert.deepEqual(pagination({data:{pagination:{hasMore:false}}}),{more:false,cursor:''});
});
class Storage {constructor(){this.map=new Map();this.alarm=null;}async get(k){return structuredClone(this.map.get(k));}async put(k,v){this.map.set(k,structuredClone(v));}async delete(k){this.map.delete(k);}async list({prefix}={}){return new Map([...this.map].filter(([k])=>!prefix||k.startsWith(prefix)));}async setAlarm(v){this.alarm=v;}}
class Bucket {constructor(){this.map=new Map();}async get(k){const raw=this.map.get(k);return raw?{json:async()=>JSON.parse(raw)}:null;}async put(k,v){this.map.set(k,v);}async delete(k){this.map.delete(k);}}
const setup=()=>{const storage=new Storage(),bucket=new Bucket();const c=new CatalogCoordinator({storage,blockConcurrencyWhile:fn=>fn()},{CATALOG:bucket});return {c,storage,bucket};};
test('full sync publishes only a complete metadata snapshot',async()=>{
 const {c,storage,bucket}=setup();await storage.put('queue',[{key:'dramabox',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f,page)=>({bookId:'1',bookName:'First',cover:'https://img.test/1',chapterCount:10,hasMore:false});
 for(let n=0;n<6;n++)await c.alarm();
 const meta=await storage.get('meta:dramabox');assert.equal(meta.count,1);assert.ok(meta.version);assert.equal(await storage.get('job'),undefined);
 const snap=JSON.parse(bucket.map.get(meta.objectKey));assert.equal(snap.items[0].feeds.length,6);assert.ok(!JSON.stringify(snap).includes('sessionId'));
});
test('failed checks keep published JSON and never imply an update',async()=>{
 const {c,storage,bucket}=setup();await storage.put('meta:dramabox',{version:'old',objectKey:'old.json',count:1});bucket.map.set('old.json','{"items":[{"id":"1"}]}');
 await storage.put('queue',[{key:'dramabox',mode:'check',sessionId:'x'}]);c.upstream=async()=>{throw new Error('Provider unavailable');};
 for(let n=0;n<3;n++)await c.alarm();
 assert.equal((await storage.get('meta:dramabox')).version,'old');assert.equal((await storage.get('status:dramabox')).state,'error');assert.ok(bucket.map.has('old.json'));
});
test('unchanged probes check first pages without reloading or replacing snapshots',async()=>{
 const {c,storage,bucket}=setup();const raw={bookId:'1',bookName:'First',cover:'https://img.test/1',chapterCount:10};const probes={};
 for(let f=0;f<p.feeds.length;f++)probes[f]=await digest(normalize(raw,p,p.feeds[f].feed));
 await storage.put('meta:dramabox',{version:'old',objectKey:'old.json',probes});await storage.put('queue',[{key:'dramabox',mode:'check',sessionId:'x'}]);let calls=0;
 c.upstream=async(p,f,page)=>{calls++;assert.equal(page,1);return raw;};for(let n=0;n<6;n++)await c.alarm();
 assert.equal(calls,6);assert.equal((await storage.get('meta:dramabox')).version,'old');assert.equal((await storage.get('status:dramabox')).state,'unchanged');assert.equal(bucket.map.size,0);
});
test('new first-page metadata starts full sync and publishes a changed version',async()=>{
 const {c,storage}=setup();await storage.put('meta:dramabox',{version:'old',probes:{0:'old'}});await storage.put('queue',[{key:'dramabox',mode:'check',sessionId:'x'}]);
 c.upstream=async()=>({bookId:'2',bookName:'New series',cover:'https://img.test/2',hasMore:false});await c.alarm();assert.equal((await storage.get('job')).mode,'full');
 for(let n=0;n<6;n++)await c.alarm();assert.notEqual((await storage.get('meta:dramabox')).version,'old');
});

test('admin mutations reject cross-origin requests before authentication',async()=>{
 const worker=(await import('../src/index.mjs')).default;
 const r=await worker.fetch(new Request('https://catalog.test/admin/login',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'}),{});
 assert.equal(r.status,403);
});
test('catalog read requires a signed-in user',async()=>{
 const worker=(await import('../src/index.mjs')).default;
 const r=await worker.fetch(new Request('https://catalog.test/version.json'),{});
 assert.equal(r.status,401);
});
