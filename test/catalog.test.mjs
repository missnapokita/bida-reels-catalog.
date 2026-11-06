import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJSON,normalize,pagePath,pagination,mergeItems,digest,decodeStructured,upstreamDetail} from '../src/catalog.mjs';
import {CatalogCoordinator} from '../src/index.mjs';
import providers from '../src/providers.mjs';
const p=providers.find(p=>p.key==='dramabox');
test('long IDs remain exact, numeric text inside strings is untouched',()=>{
 const value=parseJSON('{"id":2004076783771176960,"title":"2004076783771176960","value":3}');
 assert.equal(value.id,'2004076783771176960');assert.equal(value.title,value.id);assert.equal(value.value,3);
});
test('allowlist strips media links, credentials, and unrelated provider payload',()=>{
 const result=normalize({data:[{bookId:'9',bookName:'Hello',cover:'https://img.test/a.jpg',chapterCount:40,videoUrl:'https://test/secret.m3u8',token:'secret',episodes:[{url:'secret'}]}]},p,'latest');
 assert.equal(result.length,1);assert.equal(result[0].episodes,40);assert.deepEqual(Object.keys(result[0]).sort(),['description','episodes','feeds','genre','id','latestRank','newRelease','posterUrl','title','viral','viralRank']);
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

test('pagination understands total pages and total counts when hasMore is absent',()=>{
 assert.deepEqual(pagination({data:{pagination:{current_page:2,total_pages:5}}}),{more:true,cursor:''});
 assert.equal(pagination({meta:{total:45,page_size:20}},2).more,true);
 assert.equal(pagination({meta:{total:45,page_size:20}},3).more,false);
 assert.equal(pagination({data:{hasMore:false,totalPages:8}},1).more,false);
});
test('repeated hasMore pages yield an honest partial refresh retaining every previous title',async()=>{
 const {c,storage,bucket}=setup();
 await storage.put('meta:reelshort',{version:'old',objectKey:'old.json',count:1});
 bucket.map.set('old.json','{"items":[{"id":"old","title":"Old title","posterUrl":"https://img.test/old","feeds":["latest"]}]}');
 await storage.put('queue',[{key:'reelshort',mode:'full',sessionId:'x'}]);
 c.upstream=async()=>({id:'1',title:'Repeated',posterUrl:'https://img.test/1',hasMore:true});
 for(let n=0;n<5;n++)await c.alarm();
 const meta=await storage.get('meta:reelshort'),status=await storage.get('status:reelshort');
 assert.equal(meta.complete,false);assert.equal(status.state,'partial');assert.equal(meta.count,2);
 const snap=JSON.parse(bucket.map.get(meta.objectKey));
 assert.deepEqual(snap.items.map(i=>i.id),['old','1']);assert.equal(snap.coverage.complete,false);
 assert.match(status.warning,/Pagination repeats/);assert.equal(await storage.get('job'),undefined);
});
test('total-page metadata crawls every page before atomically publishing',async()=>{
 const {c,storage,bucket}=setup();await storage.put('queue',[{key:'reelshort',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f,page)=>({items:[{id:String(page),title:'Title '+page,posterUrl:'https://img.test/'+page}],pagination:{totalPages:3,currentPage:page}});
 await c.alarm();await c.alarm();assert.equal(await storage.get('meta:reelshort'),undefined);
 await c.alarm();const meta=await storage.get('meta:reelshort');assert.equal(meta.count,3);
 assert.equal(JSON.parse(bucket.map.get(meta.objectKey)).items.length,3);
});

test('nested JSON strings are decoded like the app parser, preserving long IDs',()=>{
 const raw={data:JSON.stringify({list:JSON.stringify([{id:'2004076783771176960',title:'Fun title',cover:'//img.test/fun'}])})};
 const items=normalize(raw,providers.find(p=>p.key==='fundrama'));
 assert.equal(items.length,1);assert.equal(items[0].id,'2004076783771176960');assert.equal(items[0].posterUrl,'https://img.test/fun');
 assert.equal(normalize({isAdult:true,data:raw},p).length,0);
});
test('pagination decodes string envelopes and ignores unknown flags',()=>{
 assert.deepEqual(pagination({data:JSON.stringify({pagination:{hasMore:false,nextCursor:'abc'}})}),{more:false,cursor:'abc'});
 assert.equal(pagination({hasMore:'unknown'}).more,null);
 assert.equal(decodeStructured(JSON.stringify(JSON.stringify({a:1}))).a,1);
});
test('Plerplow continues popular and trending after an unusable class feed',async()=>{
 const {c,storage,bucket}=setup();await storage.put('queue',[{key:'plerplow',mode:'full',sessionId:'x'}]);
 const paths=[];c.upstream=async(p,f)=>{paths.push(f.path);return f.path.includes('/class?')?{data:[]}:{id:'p1',title:'Fallback title',posterUrl:'https://img.test/p',hasMore:false};};
 for(let n=0;n<5;n++)await c.alarm();
 const meta=await storage.get('meta:plerplow');assert.equal(meta.count,1);assert.equal(meta.complete,false);
 assert.equal((await storage.get('status:plerplow')).state,'partial');
 assert.ok(paths.some(p=>p.includes('/popular')));assert.ok(paths.some(p=>p.includes('/trending')));
 assert.equal(JSON.parse(bucket.map.get(meta.objectKey)).coverage.issues.length,1);
});
test('FunDrama encoded list publishes actual titles rather than reporting no usable items',async()=>{
 const {c,storage}=setup();await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'x'}]);
 c.upstream=async()=>({hasMore:false,data:JSON.stringify({items:[{id:'f1',title:'Fun title',cover:'https://img.test/f'}]})});
 await c.alarm();assert.equal((await storage.get('meta:fundrama')).count,1);
 assert.equal((await storage.get('status:fundrama')).state,'published');
});
test('all empty feeds keep the previous JSON and report response structure',async()=>{
 const {c,storage,bucket}=setup();await storage.put('meta:fundrama',{version:'old',objectKey:'old.json',count:1});
 bucket.map.set('old.json','{"items":[{"id":"old"}]}');await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'x'}]);
 c.upstream=async()=>({code:0,data:[]});for(let n=0;n<6;n++)await c.alarm();
 assert.equal((await storage.get('meta:fundrama')).version,'old');
 const status=await storage.get('status:fundrama');assert.equal(status.state,'error');assert.match(status.error,/keys=code,data/);
 assert.equal(await storage.get('job'),undefined);
});
test('a temporary timeout retains the same page and exposes a scheduled retry',async()=>{
 const {c,storage}=setup();await storage.put('queue',[{key:'reelshort',mode:'full',sessionId:'x'}]);let n=0;
 c.upstream=async()=>{if(n++<3)throw Object.assign(new Error('Provider timed out'),{retryable:true});return {id:'1',title:'Recovered',posterUrl:'https://img.test/1',hasMore:false};};
 await c.alarm();const first=await storage.get('job');assert.equal(first.page,1);assert.equal(first.tries,1);
 assert.equal((await storage.get('status:reelshort')).state,'retrying');assert.ok(storage.alarm>Date.now());
 for(let i=0;i<3;i++)await c.alarm();assert.equal((await storage.get('status:reelshort')).state,'published');
});
test('transient 502s get five attempts and do not repeatedly lose staged titles',async()=>{
 const {c,storage,bucket}=setup();await storage.put('queue',[{key:'reelshort',mode:'full',sessionId:'x'}]);
 let n=0;c.upstream=async(p,f,page)=>{if(page===1)return {id:'1',title:'First',cover:'https://img.test/1',hasMore:true};
 if(n++<4)throw Object.assign(new Error('Provider request failed (HTTP 502)'),{retryable:true});return {id:'2',title:'Second',cover:'https://img.test/2',hasMore:false};};
 for(let i=0;i<6;i++)await c.alarm();const meta=await storage.get('meta:reelshort');assert.equal(meta.count,2);assert.equal(meta.complete,true);
 assert.equal(JSON.parse(bucket.map.get(meta.objectKey)).items.length,2);
});
test('a partially refreshed provider forces a new full scan on the next check',async()=>{
 const {c,storage}=setup();await storage.put('meta:reelshort',{version:'old',complete:false,probes:{}});
 await storage.put('queue',[{key:'reelshort',mode:'check',sessionId:'x'}]);
 c.upstream=async()=>({id:'1',title:'Recovered',cover:'https://img.test/1',hasMore:false});await c.alarm();
 assert.equal((await storage.get('meta:reelshort')).complete,true);assert.equal((await storage.get('status:reelshort')).state,'published');
});
test('expired administrator session stops immediately and retains the published JSON',async()=>{
 const {c,storage}=setup();await storage.put('meta:fundrama',{version:'old'});
 await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'x'}]);
 c.upstream=async()=>{throw new Error('Admin session expired; sign in again');};await c.alarm();
 assert.equal(await storage.get('job'),undefined);assert.equal((await storage.get('status:fundrama')).state,'error');assert.equal((await storage.get('meta:fundrama')).version,'old');
});
test('application failures with HTTP 200 preserve upstream meaning without exposing tokens',async()=>{
 const {c}=setup();c.token=async()=> 'fake';c.env.UPSTREAM_GATEWAY='https://gateway.test';
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({success:false,code:'UPSTREAM_TIMEOUT',message:'Timeout token=secret https://test/private'}),{status:200});
 try {await assert.rejects(c.upstream(p,p.feeds[0],1,'x'),e=>{assert.equal(e.retryable,true);assert.match(e.message,/HTTP 200/);assert.match(e.message,/UPSTREAM_TIMEOUT/);assert.ok(!e.message.includes('secret'));assert.ok(!e.message.includes('https://test'));return true;});}
 finally{globalThis.fetch=original;}
});
test('HTML 502 and aborted fetches become contextual retryable errors',async()=>{
 const {c}=setup();c.token=async()=> 'fake';c.env.UPSTREAM_GATEWAY='https://gateway.test';const original=globalThis.fetch;
 try {
  globalThis.fetch=async()=>new Response('<html>Bad gateway</html>',{status:502});
  await assert.rejects(c.upstream(p,p.feeds[0],1,'x'),e=>e.retryable&&/HTTP 502/.test(e.message));
  globalThis.fetch=async()=>{throw new DOMException('aborted','TimeoutError');};
  await assert.rejects(c.upstream(p,p.feeds[0],1,'x','',1),e=>e.retryable&&/45 seconds/.test(e.message));
 }finally{globalThis.fetch=original;}
});
test('finalization can retry without re-fetching or advancing past the feed list',async()=>{
 const {c,storage,bucket}=setup();await storage.put('queue',[{key:'reelshort',mode:'full',sessionId:'x'}]);
 const put=bucket.put.bind(bucket);let fail=true;bucket.put=async(k,v)=>{if(k.startsWith('snapshots/')&&fail){fail=false;throw new Error('Temporary storage failure');}return put(k,v);};
 let requests=0;c.upstream=async()=>{requests++;return {id:'1',title:'First',cover:'https://img.test/1',hasMore:false};};
 await c.alarm();assert.equal((await storage.get('status:reelshort')).state,'retrying');assert.equal(await storage.get('meta:reelshort'),undefined);
 await c.alarm();assert.equal((await storage.get('status:reelshort')).state,'published');assert.equal(requests,1);
});

test('declared last page ends a feed even when hasMore incorrectly stays true',()=>{
 assert.equal(pagination({hasMore:true,totalPages:12,currentPage:12},12).more,false);
 assert.equal(pagination({hasMore:true,data:{pagination:{totalPages:12}}},13).more,false);
 assert.equal(pagination({hasMore:true,totalPages:12},11).more,true);
 assert.equal(pagination({hasMore:true},13).more,true);
});
test('NetShort publishes beyond the former page 80 ceiling',async()=>{
 const {c,storage}=setup();await storage.put('queue',[{key:'netshort',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f,page)=>({items:[{id:String(page),title:'Series '+page,posterUrl:'https://img.test/'+page}],hasMore:f.paged && page<85});
 for(let n=0;n<170;n++)await c.alarm();
 const meta=await storage.get('meta:netshort');assert.equal(meta.count,85);assert.equal(meta.complete,true);
 assert.equal((await storage.get('status:netshort')).state,'published');
});
test('safety ceiling keeps the final fetched page and reports incomplete coverage',async()=>{
 const {c,storage,bucket}=setup();c.env.MAX_FEED_PAGES=100;
 await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f,page)=>({items:[{id:String(page),title:'Series '+page,posterUrl:'https://img.test/'+page}],hasMore:true});
 for(let n=0;n<100;n++)await c.alarm();
 const meta=await storage.get('meta:fundrama');assert.equal(meta.count,100);assert.equal(meta.complete,false);
 assert.ok(JSON.parse(bucket.map.get(meta.objectKey)).items.some(i=>i.id==='100'));
 assert.match((await storage.get('status:fundrama')).warning,/safety limit/);
});
test('ReelShort retries use the app shelf route without losing page or language',async()=>{
 const {c}=setup();c.token=async()=> 'fake';c.env.UPSTREAM_GATEWAY='https://gateway.test';
 const reel=providers.find(p=>p.key==='reelshort'),original=globalThis.fetch,urls=[];
 globalThis.fetch=async(url)=>{urls.push(new URL(url));return new Response(JSON.stringify({success:true,data:[]}));};
 try {
  await c.upstream(reel,reel.feeds[0],4,'x','',0);
  await c.upstream(reel,reel.feeds[0],4,'x','',2);
  assert.equal(urls[0].pathname,'/api/catalog');
  assert.equal(urls[1].pathname,'/api/provider-data');
  const path=urls[1].searchParams.get('path');assert.match(path,/shelf\/2009269/);assert.match(path,/page=4/);assert.match(path,/lang=en/);
 }finally{globalThis.fetch=original;}
});
test('DramaWave permanent 502 retains previous titles and publishes successful feeds honestly',async()=>{
 const {c,storage,bucket}=setup();
 await storage.put('meta:dramawave',{version:'old',objectKey:'old.json'});
 bucket.map.set('old.json',JSON.stringify({items:[{id:'old',title:'Old series',posterUrl:'https://img.test/old',feeds:['route_1']}]}));
 await storage.put('queue',[{key:'dramawave',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f)=>{if(f.path.includes('/new-drama'))throw Object.assign(new Error('Provider request failed (HTTP 502)'),{retryable:true});
 return {id:'new',title:'New series',posterUrl:'https://img.test/new',hasMore:false};};
 for(let n=0;n<7;n++)await c.alarm();
 const meta=await storage.get('meta:dramawave');assert.equal(meta.count,2);assert.equal(meta.complete,false);
 assert.match((await storage.get('status:dramawave')).warning,/HTTP 502/);
});
test('empty cursor sentinels do not generate fake next-page tokens',()=>{
 assert.equal(pagination({nextCursor:'null'}).cursor,'');
 assert.equal(pagination({nextCursor:false}).cursor,'');
 assert.equal(pagination({nextCursor:''}).cursor,'');
});

test('retrying an incomplete sync resumes the failed page and retains earlier pages',async()=>{
 const {c,storage,bucket}=setup();await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'old-session'}]);
 c.upstream=async(p,f,page)=>{if(page===3)throw new Error('upstream unavailable');return {id:String(page),title:'Series '+page,posterUrl:'https://img.test/'+page,hasMore:true};};
 for(let n=0;n<6;n++)await c.alarm();
 assert.equal((await storage.get('meta:fundrama')).complete,false);
 const saved=await storage.get('resume:fundrama');assert.equal(saved.tasks[0].page,3);assert.equal(saved.sessionId,undefined);
 // A new coordinator instance simulates an eviction/restart; credentials come from the new queue entry.
 const restarted=new CatalogCoordinator({storage,blockConcurrencyWhile:fn=>fn()},{CATALOG:bucket});const calls=[];
 restarted.upstream=async(p,f,page,session)=>{calls.push(page);assert.equal(session,'new-session');return {id:String(page),title:'Series '+page,posterUrl:'https://img.test/'+page,hasMore:page<4};};
 await storage.put('queue',[{key:'fundrama',mode:'resume',sessionId:'new-session'}]);await restarted.alarm();await restarted.alarm();
 assert.deepEqual(calls,[3,4]);const meta=await storage.get('meta:fundrama');assert.equal(meta.count,4);assert.equal(meta.complete,true);
 assert.equal(await storage.get('resume:fundrama'),undefined);
});
test('resume retries only the failed DramaWave feed, not its completed feeds',async()=>{
 const {c,storage}=setup();await storage.put('queue',[{key:'dramawave',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f)=>{if(f.path.includes('new-drama'))throw new Error('502');return {id:f.path,title:'Series title',posterUrl:'https://img.test/a',hasMore:false};};
 for(let n=0;n<5;n++)await c.alarm();assert.ok(await storage.get('resume:dramawave'));
 const calls=[];c.upstream=async(p,f)=>{calls.push(f.path);return {id:'recovered',title:'Recovered title',posterUrl:'https://img.test/b',hasMore:false};};
 await storage.put('queue',[{key:'dramawave',mode:'check',sessionId:'x'}]);await c.alarm();
 assert.equal(calls.length,1);assert.match(calls[0],/new-drama/);assert.equal((await storage.get('meta:dramawave')).complete,true);
 assert.equal((await storage.get('meta:dramawave')).count,3);
});
test('page ceiling checkpoint continues at the next page rather than restarting',async()=>{
 const {c,storage}=setup();c.env.MAX_FEED_PAGES=100;await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f,page)=>({id:String(page),title:'Series '+page,posterUrl:'https://img.test/'+page,hasMore:page<102});
 for(let n=0;n<100;n++)await c.alarm();assert.equal((await storage.get('resume:fundrama')).tasks[0].page,101);
 const calls=[],upstream=c.upstream;c.upstream=async(...args)=>{calls.push(args[2]);return upstream(...args);};
 await storage.put('queue',[{key:'fundrama',mode:'resume',sessionId:'x'}]);await c.alarm();await c.alarm();
 assert.deepEqual(calls,[101,102]);assert.equal((await storage.get('meta:fundrama')).count,102);assert.equal((await storage.get('meta:fundrama')).complete,true);
});
test('Full sync explicitly restarts rather than using a saved checkpoint',async()=>{
 const {c,storage,bucket}=setup();await storage.put('resume:fundrama',{id:'old',tasks:[{feed:0,page:9,cursor:''}]});bucket.map.set('staging/old.json','[]');
 await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'x'}]);
 c.upstream=async(p,f,page)=>{assert.equal(page,1);return {id:'one',title:'New series',posterUrl:'https://img.test/1',hasMore:false};};
 await c.alarm();assert.equal((await storage.get('meta:fundrama')).complete,true);assert.equal(await storage.get('resume:fundrama'),undefined);assert.equal(bucket.map.has('staging/old.json'),false);
});
test('an expired session keeps a checkpoint for a new administrator session',async()=>{
 const {c,storage}=setup();await storage.put('queue',[{key:'fundrama',mode:'full',sessionId:'old'}]);
 c.upstream=async(p,f,page)=>{if(page===2)throw new Error('Admin session expired; sign in again');return {id:'one',title:'First title',posterUrl:'https://img.test/1',hasMore:true};};
 await c.alarm();await c.alarm();assert.equal((await storage.get('resume:fundrama')).tasks[0].page,2);
 c.upstream=async(p,f,page,session)=>{assert.equal(page,2);assert.equal(session,'new');return {id:'two',title:'Second title',posterUrl:'https://img.test/2',hasMore:false};};
 await storage.put('queue',[{key:'fundrama',mode:'resume',sessionId:'new'}]);await c.alarm();assert.equal((await storage.get('meta:fundrama')).count,2);
});
test('changed diagnostic wording does not force a new catalog version',async()=>{
 const {c,storage}=setup();let message='timeout one';
 c.upstream=async(p,f)=>{if(f.path.includes('new-drama'))throw new Error(message);return {id:f.path,title:'Same title',posterUrl:'https://img.test/a',hasMore:false};};
 for(let run=0;run<2;run++){
 await storage.put('queue',[{key:'dramawave',mode:'full',sessionId:'x'}]);for(let n=0;n<5;n++)await c.alarm();
 const version=(await storage.get('meta:dramawave')).version;
 if(run===0){storage.firstVersion=version;message='timeout with changed detail';}else assert.equal(version,storage.firstVersion);
 }
});

test('NetShort list advances the page in the path instead of adding a query parameter',()=>{
 const net=providers.find(p=>p.key==='netshort'),feed=net.feeds.find(f=>f.path.includes('/api/list/'));
 assert.equal(feed.paged,true);
 for(const page of [1,3,14,100]){
  const route=new URL('https://gateway.test'+pagePath(net,feed,page));
  assert.equal(route.searchParams.get('path'),'/api/list/'+page+'?lang=en');
 }
});
test('DramaWave numeric next advances even when the response has no cursor field',()=>{
 const wave=providers.find(p=>p.key==='dramawave');
 for(const feed of wave.feeds.filter(f=>f.path.includes('next='))){
  assert.equal(feed.paged,true);
  const path=new URL('https://gateway.test'+pagePath(wave,feed,3)).searchParams.get('path');
  const endpoint=new URL(path,wave.root);assert.equal(endpoint.searchParams.get('next'),'3');assert.equal(endpoint.searchParams.has('page'),false);
 }
});
test('DramaWave crawls later numeric-next pages before completing its snapshot',async()=>{
 const {c,storage,bucket}=setup(),wave=providers.find(p=>p.key==='dramawave');
 await storage.put('queue',[{key:'dramawave',mode:'full',sessionId:'x'}]);const pages=[];
 c.upstream=async(p,f,page)=>{pages.push({path:f.path,page});return {dramas:[{id:f.path+'-'+page,title:'Fixture title',cover:'https://img.test/a'}],hasMore:f.paged&&page<3};};
 for(let n=0;n<7;n++)await c.alarm();
 const meta=await storage.get('meta:dramawave');assert.equal(meta.complete,true);assert.equal(meta.count,7);
 assert.equal(pages.filter(c=>c.page===3).length,2);assert.equal(JSON.parse(bucket.map.get(meta.objectKey)).items.length,7);
});
test('HappyShort response structure observed in the browser normalizes and stops on has_next',()=>{
 const happy=providers.find(p=>p.key==='happyshort');
 const row={id:606305,video_id:606305,video_name:'Fixture drama',name:'Fixture drama',cover:'https://img.test/cover',big_cover:'https://img.test/large',episode_num:70,introduce:'Fixture description'};
 const raw={dramas:[row],videos:[row],page:1,size:20,total:484,total_pages:25,has_next:true};
 const items=normalize(raw,happy);assert.equal(items.length,1);assert.equal(items[0].id,'606305');assert.equal(items[0].episodes,70);
 assert.equal(pagination(raw).more,true);assert.equal(pagination({...raw,page:25,has_next:false},25).more,false);
 assert.match(happy.feeds[0].path,/size=20/);
});
