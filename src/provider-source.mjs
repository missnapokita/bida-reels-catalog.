import {pagePath,parseJSON,decodeStructured,upstreamDetail} from './catalog.mjs';
const fail=(message,retryable=false)=>Object.assign(new Error(message),{feedFailure:true,retryable});

// Provider URLs come only from the server-owned registry, never a client-supplied host.
export function directRequest(provider,feed,page,accessCode,cursor='') {
  if(feed.path&&(!feed.path.startsWith('/')||feed.path.startsWith('//')||feed.path.includes('\\')))
    throw fail('Invalid provider feed path');
  let path;
  if(provider.key==='dramabox' && feed.feed) {
    const name=feed.feed;
    if(['latest','trending','foryou'].includes(name))path='/api/dramabox/'+name+'?lang=en';
    else if(name==='browse')path='/api/dramabox/browse?lang=en&page='+page;
    else if(['dubbed_latest','dubbed_popular'].includes(name))path='/api/dramabox/dubbed?lang=en&page='+page+'&classify='+(name==='dubbed_latest'?'terbaru':'terpopuler');
    else throw fail('Unsupported DramaBox catalog feed');
  } else if(provider.key==='reelshort' && feed.feed==='latest') {
    path='/shelf/2009269?page='+page+'&limit=24&lang=en';
  } else {
    const gateway=new URL(pagePath(provider,feed,page,cursor),'https://internal');
    path=gateway.searchParams.get('path');
  }
  if(!path?.startsWith('/')||path.startsWith('//'))throw fail('Invalid provider feed path');
  const root=new URL(provider.root),url=new URL(path,root);
  if(root.protocol!=='https:'||url.origin!==root.origin||url.username||url.password)throw fail('Invalid provider origin');
  const headers={Accept:'application/json'};
  if(['dramabox','bonustv'].includes(provider.key))headers['x-token']=accessCode;
  else url.searchParams.set('code',accessCode);
  return {url:url.href,headers,redirect:'error'};
}

export function providerPayload(text,status) {
  if(text.length>8*1024*1024)throw fail('Provider response is too large');
  let body;
  try {body=decodeStructured(parseJSON(text));}
  catch {throw fail('Provider returned non-JSON data (HTTP '+status+')',status===429||status>=500);}
  const detail=upstreamDetail(body);
  if(status<200||status>=300)throw fail('Provider request failed (HTTP '+status+(detail?'; '+detail:'')+')',status===408||status===429||status>=500);
  if(!body||typeof body!=='object')throw fail('Provider returned no structured data');
  const code=body.code;
  if(body.success===false||body.status===false||['error','failed','failure'].includes(String(body.status).toLowerCase())
      ||(typeof code==='number'&&code!==0&&code!==200))
    throw fail('Provider application error'+(detail?': '+detail:''),true);
  const nested=decodeStructured(body.data);
  if(nested?.success===false)throw fail('Provider application error'+(upstreamDetail(nested)?': '+upstreamDetail(nested):''),true);
  // Keep the complete envelope: pagination often lives next to, rather than inside, data.
  return body;
}

export async function fetchProvider(provider,feed,page,env,cursor='',attempt=0) {
  const request=directRequest(provider,feed,page,env.PROVIDER_ACCESS_CODE,cursor);
  if(attempt)request.headers['Cache-Control']='no-cache';
  try {
    const response=await fetch(request.url,{headers:request.headers,redirect:request.redirect,signal:AbortSignal.timeout(Math.min(60000,30000+attempt*15000))});
    return providerPayload(await response.text(),response.status);
  } catch(error) {
    if(error.feedFailure)throw error;
    throw fail(error.name==='TimeoutError'||error.name==='AbortError'?'Provider request timed out':'Provider network request failed',true);
  }
}

export const directoryId=key=>({plerplow:'flareflow',shortwave:'shortswave'}[key]||key);
