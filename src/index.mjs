import providers from './providers.mjs';
import {parseJSON,normalize,pagePath,pagination,mergeItems,digest,stableItems,decodeStructured,responseShape,upstreamDetail} from './catalog.mjs';
import adminHTML from './ui.mjs';
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const feedError = (message,retryable=false) => Object.assign(new Error(message),{feedFailure:true,retryable});
const stub = env => env.COORDINATOR.get(env.COORDINATOR.idFromName('catalog'));
async function rpc(env,path,data) {
  const res=await stub(env).fetch('https://internal'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});
  const body=await res.json();if(!res.ok)throw new Error(body.error||'Coordinator error');return body;
}
function allowed(env,uid) {return (env.ADMIN_UIDS||'').split(',').map(v=>v.trim()).includes(uid);}
async function firebase(env,path,data) {
  if(!env.FIREBASE_API_KEY)throw new Error('Firebase API key is not configured');
  const r=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:'+path+'?key='+encodeURIComponent(env.FIREBASE_API_KEY),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
  const body=await r.json();if(!r.ok)throw new Error('Account verification failed');return body;
}
async function verifyUser(env,token) {
  if(!token)throw new Error('Sign in required');
  const body=await firebase(env,'lookup',{idToken:token});const user=body.users?.[0];if(!user || user.disabled)throw new Error('Sign in required');return user.localId;
}
function cookie(req) {return (req.headers.get('Cookie')||'').match(/(?:^|;\s*)bida_admin=([a-f0-9]{64})(?:;|$)/)?.[1]||'';}
function isSameOrigin(req) {return req.headers.get('Origin')===new URL(req.url).origin;}
export default {
  async fetch(req,env) {
    const u=new URL(req.url);
    try {
      if(u.pathname==='/' && req.method==='GET')return new Response(adminHTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com; frame-src https://*.firebaseapp.com https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src https: data:; connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com; frame-ancestors 'none'; base-uri 'none'"}});
      if(u.pathname==='/auth-config' && req.method==='GET')return json({apiKey:env.FIREBASE_API_KEY,projectId:env.FIREBASE_PROJECT_ID,authDomain:env.FIREBASE_AUTH_DOMAIN||env.FIREBASE_PROJECT_ID+'.firebaseapp.com'});
      if(u.pathname==='/admin/google-login' && req.method==='POST') {
        if(!isSameOrigin(req))return json({error:'Invalid origin'},403);
        const {idToken,refreshToken}=await req.json();
        if(typeof idToken!=='string'||typeof refreshToken!=='string'||!idToken||!refreshToken||idToken.length>16384||refreshToken.length>16384)return json({error:'Invalid login'},400);
        const uid=await verifyUser(env,idToken);
        if(!allowed(env,uid))return json({error:'This account is not an administrator'},403);
        const r=await fetch('https://securetoken.googleapis.com/v1/token?key='+encodeURIComponent(env.FIREBASE_API_KEY),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}),signal:AbortSignal.timeout(15000)});
        const v=await r.json();
        if(!r.ok||v.user_id!==uid||!v.id_token||!v.refresh_token) return json({error:'Account verification failed'},401);
        if(await verifyUser(env,v.id_token)!==uid)return json({error:'Account verification failed'},401);
        const session=await rpc(env,'/session/new',{uid,refreshToken:v.refresh_token});
        const res=json({success:true});res.headers.set('Set-Cookie','bida_admin='+session.id+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800');return res;
      }
      if(u.pathname==='/health')return json({success:true,service:'BidaReels catalog',configured:!!env.FIREBASE_API_KEY && !env.ADMIN_UIDS?.includes('REPLACE')});
      if(u.pathname==='/admin/login' && req.method==='POST') {
        if(!isSameOrigin(req))return json({error:'Invalid origin'},403);
        const {email,password}=await req.json();
        if(typeof email!=='string'||typeof password!=='string'||email.length>254||password.length>256)return json({error:'Invalid login'},400);
        const result=await firebase(env,'signInWithPassword',{email,password,returnSecureToken:true});
        if(!allowed(env,result.localId))return json({error:'This account is not an administrator'},403);
        const resultSession=await rpc(env,'/session/new',{uid:result.localId,refreshToken:result.refreshToken});
        const res=json({success:true});res.headers.set('Set-Cookie','bida_admin='+resultSession.id+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800');return res;
      }
      if(u.pathname.startsWith('/admin/')) {
        if(req.method==='POST' && !isSameOrigin(req))return json({error:'Invalid origin'},403);
        const id=cookie(req);const session=await rpc(env,'/session/get',{id});
        if(!session.uid || !allowed(env,session.uid))return json({error:'Sign in required'},401);
        if(u.pathname==='/admin/logout' && req.method==='POST') {
          await rpc(env,'/session/delete',{id});const res=json({success:true});res.headers.set('Set-Cookie','bida_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');return res;
        }
        if(u.pathname==='/admin/status' && req.method==='GET')return json(await rpc(env,'/status'));
        if(u.pathname==='/admin/sync' && req.method==='POST') {
          const body=await req.json();const keys=body.provider==='all'?providers.map(p=>p.key):[body.provider];
          if(keys.some(k=>!providers.some(p=>p.key===k)))return json({error:'Unknown provider'},400);
          return json(await rpc(env,'/queue',{keys,mode:body.mode==='full'?'full':'check',sessionId:id}));
        }
        if(u.pathname==='/admin/automation' && req.method==='POST')return json(await rpc(env,'/automation',{id,enabled:!!(await req.json()).enabled}));
        if(u.pathname==='/admin/items' && req.method==='GET') {
          const key=u.searchParams.get('provider'), meta=await rpc(env,'/meta',{key});
          if(!meta.version)return json({items:[]});
          const object=await env.CATALOG.get(meta.objectKey);if(!object)throw new Error('Catalog snapshot missing');
          return new Response(object.body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
        }
        return json({error:'Not found'},404);
      }
      if(u.pathname==='/version.json'||/^\/catalog\/[a-z]+\.json$/.test(u.pathname)) {
        if(req.method!=='GET')return json({error:'Method not allowed'},405);
        await verifyUser(env,(req.headers.get('Authorization')||'').replace(/^Bearer /,''));
        if(u.pathname==='/version.json')return json(await rpc(env,'/versions'));
        const key=u.pathname.split('/').pop().replace('.json','');const meta=await rpc(env,'/meta',{key});
        if(!meta.version)return json({error:'Catalog is not published yet. Ask the admin to sync '+key},404);
        if(req.headers.get('If-None-Match')==='"'+meta.version+'"')return new Response(null,{status:304,headers:{ETag:'"'+meta.version+'"'}});
        const object=await env.CATALOG.get(meta.objectKey);if(!object)throw new Error('Catalog snapshot missing');
        return new Response(object.body,{headers:{'Content-Type':'application/json; charset=utf-8',ETag:'"'+meta.version+'"','Cache-Control':'private, no-cache'}});
      }
      return json({error:'Not found'},404);
    } catch(error) {return json({error:error.message||'Request failed'}, /Account verification|Sign in/.test(error.message)?401:500);}
  },
  async scheduled(event,env,ctx) {ctx.waitUntil(rpc(env,'/cron'));}
};

export class CatalogCoordinator {
  constructor(ctx,env) {this.ctx=ctx;this.env=env;}
  async fetch(req) {
    const path=new URL(req.url).pathname;const b=await req.json();const s=this.ctx.storage;
    try {
      if(path==='/session/new') {
        const id=[...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join('');
        await s.put('session:'+id,{uid:b.uid,refreshToken:b.refreshToken,expires:Date.now()+604800000});
        // Remove expired login sessions without exposing credential data.
        for(const [k,v] of await s.list({prefix:'session:'}))if(v.expires<Date.now())await s.delete(k);
        return json({id});
      }
      if(path==='/session/get') {const session=await s.get('session:'+b.id);return json({uid:session?.expires>Date.now()?session.uid:null});}
      if(path==='/session/delete') {await s.delete('session:'+b.id);return json({success:true});}
      if(path==='/meta')return json((await s.get('meta:'+b.key))||{});
      if(path==='/versions') {
        const data={schema:1,providers:{}};
        for(const [k,v] of await s.list({prefix:'meta:'}))data.providers[k.slice(5)]={version:v.version,count:v.count,updatedAt:v.updatedAt,complete:v.complete!==false};
        return json(data);
      }
      if(path==='/status') {
        const queue=await s.get('queue')||[],job=await s.get('job');const data=[];
        for(const p of providers){const meta=await s.get('meta:'+p.key)||{};const status=await s.get('status:'+p.key)||{};data.push({key:p.key,label:p.label,...meta,...status});}
        return json({providers:data,queue:queue.map(q=>({key:q.key,mode:q.mode})),job:job?{key:job.key,mode:job.mode,page:job.page,feed:job.feed,attempt:(job.tries||0)+1}:null,automation:!!await s.get('automation')});
      }
      if(path==='/automation') {
        const session=await s.get('session:'+b.id);
        if(b.enabled && (!session||!allowed(this.env,session.uid)))throw new Error('Admin session expired');
        if(b.enabled)await s.put('automation',{uid:session.uid,refreshToken:session.refreshToken});else await s.delete('automation');
        return json({enabled:b.enabled});
      }
      if(path==='/queue'||path==='/cron') {
        const result=await this.ctx.blockConcurrencyWhile(async()=>{
          const auto=path==='/cron'?await s.get('automation'):null;
          if(path==='/cron'&&!auto)return {queued:0,automation:false};
          const keys=path==='/cron'?providers.map(p=>p.key):b.keys;
          const queue=await s.get('queue')||[],job=await s.get('job');let added=0;
          for(const key of keys)if(job?.key!==key&&!queue.some(q=>q.key===key)) {
            const meta=await s.get('meta:'+key);
            const full=path==='/cron' && !meta;
            queue.push({key,mode:full?'full':b.mode||'check',sessionId:path==='/cron'?'automation':b.sessionId});added++;
          }
          await s.put('queue',queue);if(queue.length&&!job)await s.setAlarm(Date.now()+1000);return {queued:added};
        });return json(result);
      }
      return json({error:'Unknown internal action'},404);
    } catch(e) {return json({error:e.message},500);}
  }
  async token(sessionId) {
    const s=this.ctx.storage;const key=sessionId==='automation'?'automation':'session:'+sessionId;
    const session=await s.get(key);if(!session || !allowed(this.env,session.uid) || (session.expires && session.expires<Date.now()))throw new Error('Admin session expired; sign in again');
    if(session.idToken && session.tokenExpires>Date.now()+60000)return session.idToken;
    const r=await fetch('https://securetoken.googleapis.com/v1/token?key='+encodeURIComponent(this.env.FIREBASE_API_KEY),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:session.refreshToken}),signal:AbortSignal.timeout(15000)});
    const v=await r.json();if(!r.ok || v.user_id!==session.uid)throw new Error('Admin account needs to sign in again');
    await s.put(key,{...session,refreshToken:v.refresh_token,idToken:v.id_token,tokenExpires:Date.now()+Number(v.expires_in)*1000});return v.id_token;
  }
  async upstream(p,f,page,sessionId,cursor='',attempt=0) {
    const token=await this.token(sessionId);
    const timeout=Math.min(60000,30000+attempt*15000);
    let r,text;
    try {
      r=await fetch(this.env.UPSTREAM_GATEWAY.replace(/\/$/,'')+pagePath(p,f,page,cursor),{
        headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(timeout)});
      text=await r.text();
    } catch(error) {
      if(error.name==='TimeoutError'||error.name==='AbortError')throw feedError('Provider timed out after '+timeout/1000+' seconds',true);
      throw feedError('Provider network request failed',true);
    }
    if(text.length>8*1024*1024)throw feedError('Provider response too large');
    let body;try {body=parseJSON(text);} catch {
      throw feedError('Provider returned non-JSON data (HTTP '+r.status+')',r.status===429||r.status>=500);
    }
    const detail=upstreamDetail(body);
    if(!r.ok||body?.success!==true||body.data==null)
      throw feedError('Provider request failed (HTTP '+r.status+(detail?'; '+detail:'; no successful data envelope')+')',
        r.status===408||r.status===429||r.status>=500||r.status===200);
    const data=decodeStructured(body.data);
    if(data?.success===false)throw feedError('Provider application error'+(upstreamDetail(data)?': '+upstreamDetail(data):' (success=false)'),true);
    return data;
  }
  async emptyFeedAllowed(meta, feed, feedIndex) {
    if(!feed.allowEmpty)return false;
    if(!meta)return true;
    const count=meta.feedCounts?.[String(feedIndex)];
    if(typeof count==='number')return count===0;
    // Older snapshots have no counts: inspect their actual stored membership.
    const object=await this.env.CATALOG.get(meta.objectKey);
    if(!object)return false;
    const snapshot=await object.json();
    if(!Array.isArray(snapshot.items))return false;
    const tag=feed.feed||'route_'+feedIndex;
    return !snapshot.items.some(item=>item.feeds?.includes(tag));
  }
  async publish(job,p,meta) {
    const s=this.ctx.storage,stageKey='staging/'+job.id+'.json';
    const staged=await this.env.CATALOG.get(stageKey);
    const fresh=staged?await staged.json():[];
    if(!fresh.length)throw new Error(p.label+': no usable items from any configured feed; previous JSON kept'+
      (job.issues?.length?' · '+job.issues.map(i=>i.reason).join(' | '):''));
    const issues=job.issues||[];
    let items=fresh;
    if(issues.length&&meta?.objectKey) {
      const previous=await this.env.CATALOG.get(meta.objectKey);
      if(!previous)throw new Error('Previous catalog snapshot is missing; partial update not published');
      const snapshot=await previous.json();
      if(!Array.isArray(snapshot.items))throw new Error('Previous catalog is invalid; partial update not published');
      // Keep every previously available title when any feed is incomplete.
      items=mergeItems(snapshot.items,fresh);
    }
    const coverage={complete:issues.length===0,issues};
    const version=await digest({items,coverage}),objectKey='snapshots/'+p.key+'/'+version+'.json';
    const body={schema:2,provider:p.key,version,updatedAt:Date.now(),coverage,items};
    const encoded=JSON.stringify(body);
    if(new TextEncoder().encode(encoded).length>16*1024*1024)throw new Error('Catalog exceeds the app size limit; previous JSON kept');
    await this.env.CATALOG.put(objectKey,encoded,{httpMetadata:{contentType:'application/json'}});
    await s.put('meta:'+p.key,{version,objectKey,count:items.length,updatedAt:body.updatedAt,
      lastFullSync:issues.length?(meta?.lastFullSync||null):Date.now(),complete:coverage.complete,
      probes:job.probes,feedCounts:job.feedCounts});
    await s.put('status:'+p.key,{state:issues.length?'partial':meta?.version===version?'unchanged':'published',
      checkedAt:Date.now(),error:'',warning:issues.length?'Partial refresh; available titles retained. '+issues.map(i=>i.reason).join(' | '):''});
    await this.env.CATALOG.delete(stageKey);await s.delete('job');
  }
  async alarm() {
    const s=this.ctx.storage;let job=await s.get('job');
    try {
      if(!job) {
        await this.ctx.blockConcurrencyWhile(async()=>{
          const queue=await s.get('queue')||[];if(!queue.length)return;
          job={...queue.shift(),id:crypto.randomUUID(),feed:0,page:1,cursor:'',probes:{},feedCounts:{},completedFeeds:[],startedAt:Date.now(),tries:0};
          await s.put('queue',queue);await s.put('job',job);
        });
        if(!job)return;
      }
      const p=providers.find(p=>p.key===job.key);const meta=await s.get('meta:'+p.key);
      if(job.mode==='check'&&(!meta||meta.complete===false))job.mode='full';
      if(job.feed>=p.feeds.length) {await this.publish(job,p,meta);if((await s.get('queue')||[]).length)await s.setAlarm(Date.now()+1500);return;}
      const f=p.feeds[job.feed];const feedLabel=f.feed||f.path||('route_'+job.feed);
      let raw;
      try {raw=await this.upstream(p,f,job.page,job.sessionId,job.cursor,job.tries||0);} catch(error) {
        if(/Admin session|Admin account/.test(error.message)) {error.terminal=true;throw error;}
        error.feedFailure=true;throw error;
      }
      const items=normalize(raw,p,f.feed||'route_'+job.feed,f.feed||f.path,(job.page-1)*100000);const pageDigest=await digest(stableItems(items));
      if(job.mode==='check') {
        if(!items.length && !await this.emptyFeedAllowed(meta,f,job.feed))
          throw feedError('Update check returned no usable items ('+responseShape(raw)+')');
        job.probes[String(job.feed)]=pageDigest;
        if(meta.probes?.[String(job.feed)]!==pageDigest) {
          job.mode='full';job.feed=0;job.page=1;job.probes={};job.feedCounts={};job.completedFeeds=[];
        } else {job.feed++;}
        if(job.mode==='check' && job.feed===p.feeds.length) {
          await s.put('status:'+p.key,{state:'unchanged',checkedAt:Date.now(),error:''});await s.delete('job');job=null;
        }
      } else {
        const stageKey='staging/'+job.id+'.json';const priorObject=await this.env.CATALOG.get(stageKey);
        const prior=priorObject?await priorObject.json():[];
        if(job.page===1)job.probes[String(job.feed)]=pageDigest;
        const paginationInfo=pagination(raw,job.page);
        if(job.page===1&&!items.length && !await this.emptyFeedAllowed(meta,f,job.feed))
          throw feedError('Feed returned no usable items ('+responseShape(raw)+')');
        if(!job.feedCounts)job.feedCounts={};
        const priorIds=new Set(prior.filter(i=>i.feeds?.includes(f.feed||'route_'+job.feed)).map(i=>i.id));
        const added=items.filter(i=>!priorIds.has(i.id)).length;
        const merged=mergeItems(prior,items);
        // A repeated page may be temporary. Retry before preserving the last published JSON.
        if(f.paged && paginationInfo.more===true && (!items.length || (job.page>1&&added===0)))
          throw feedError('Pagination repeats or is empty while hasMore=true; feed is incomplete');
        let done=!f.paged || !items.length || paginationInfo.more===false || (job.page>1&&added===0);
        if(p.key==='dramawave' && !paginationInfo.cursor)done=true;
        const limit=p.key==='dramabox'?1000:80;
        if(!done&&job.page>=limit)throw feedError('Page safety limit reached; feed is incomplete');
        await this.env.CATALOG.put(stageKey,JSON.stringify(merged),{httpMetadata:{contentType:'application/json'}});
        job.feedCounts[String(job.feed)]=(job.feedCounts[String(job.feed)]||0)+items.length;
        if(done && job.feed===p.feeds.length-1 && !merged.length)
          throw new Error(p.label+': all checked feeds returned no usable items; no JSON published');
        if(done) {job.completedFeeds.push(job.feed);job.feed++;job.page=1;job.cursor='';}
        else {job.page++;job.cursor=paginationInfo.cursor;}
        if(job.feed===p.feeds.length) {await this.publish(job,p,meta);job=null;}
      }
      if(job) {job.tries=0;await s.put('job',job);await s.put('status:'+job.key,{state:job.mode==='check'?'checking':'syncing',error:'',warning:''});}
    } catch(error) {
      if(job) {
        const p=providers.find(p=>p.key===job.key),f=p.feeds[job.feed];
        const context=p.label+' '+(f?.feed||f?.path||'publication')+' · page '+job.page;
        const reason=context+': '+error.message;
        job.tries=(job.tries||0)+1;
        const attempts=error.retryable?5:3;
        if(!error.terminal&&job.tries<attempts) {
          const retryAt=Date.now()+[10000,30000,60000,120000][Math.min(job.tries-1,3)];
          await s.put('job',job);
          await s.put('status:'+job.key,{state:'retrying',error:reason,warning:'Retry '+(job.tries+1)+'/'+attempts+' scheduled',nextRetryAt:retryAt});
          await s.setAlarm(retryAt);return;
        }
        if(error.feedFailure&&job.mode==='full'&&f) {
          if(!job.issues)job.issues=[];
          job.issues.push({feed:job.feed,page:job.page,reason});
          delete job.probes[String(job.feed)];
          job.feed++;job.page=1;job.cursor='';job.tries=0;
          await s.put('job',job);
          await s.put('status:'+job.key,{state:'syncing',error:'',warning:reason+' · Continuing remaining feeds'});
        } else {
          await s.put('status:'+job.key,{state:'error',checkedAt:Date.now(),error:reason,warning:''});
          await this.env.CATALOG.delete('staging/'+job.id+'.json');await s.delete('job');job=null;
        }
      }
    }
    if(job || (await s.get('queue')||[]).length)await s.setAlarm(Date.now()+1500);
  }
}
