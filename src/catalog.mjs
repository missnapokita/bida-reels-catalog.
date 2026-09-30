import aliases from './aliases.mjs';
export function parseJSON(text) {
  // Preserve long provider IDs before JS can round them. Never rewrite inside strings.
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    value => /^-?\d{16,}$/.test(value) ? JSON.stringify(value) : value));
}
const field = (o, keys) => {
  for (const k of keys) if (['string','number'].includes(typeof o[k]) && String(o[k]).trim()) return String(o[k]).trim();
  return '';
};
export function normalize(raw, provider, feed = '') {
  const found = new Map();
  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
    if (value.isAdult === true || value.is_adult === true) return;
    const id = field(value, aliases.id), title = field(value, aliases.title);
    let posterUrl = field(value, aliases.posterUrl);
    if (posterUrl.startsWith('//')) posterUrl = 'https:' + posterUrl;
    else if (posterUrl.startsWith('/')) posterUrl = new URL(posterUrl, provider.root).href;
    if (id && title.length >= 2 && /^https:\/\//.test(posterUrl)) {
      let genre = field(value, aliases.genre);
      if (!genre && Array.isArray(value.tags)) genre = value.tags.map(t => typeof t === 'string' ? t : t.name || t.tagName || '').filter(Boolean).join(', ');
      const item = { id, title, posterUrl, description: field(value, aliases.description),
        genre: genre || 'Short Drama', episodes: Math.max(0, parseInt(field(value, aliases.episodes),10) || 0), feeds: feed ? [feed] : [] };
      const old = found.get(id); if (old) item.feeds = [...new Set([...old.feeds, ...item.feeds])];
      found.set(id, item);
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, depth + 1);
  }
  walk(raw); return [...found.values()];
}
export function pagePath(provider, feed, page, cursor = '') {
  if (feed.feed) return '/api/catalog?provider=' + provider.key + '&feed=' + feed.feed + '&page=' + page;
  let path = feed.path;
  if (provider.key === 'netshort' && path.includes('/api/home/')) path = path.replace(/\/api\/home\/\d+/, '/api/home/' + page);
  else {
    const u = new URL(path, provider.root);
    if (u.searchParams.has('offset')) u.searchParams.set('offset', String((page-1) * (Number(u.searchParams.get('limit')) || 20)));
    else if (u.searchParams.has('page')) u.searchParams.set('page', String(page));
    else if (u.searchParams.has('p')) u.searchParams.set('p', String(page));
    else if (page > 1) u.searchParams.set('page', String(page));
    if (cursor) u.searchParams.set('next', cursor);
    path = u.pathname + u.search;
  }
  return '/api/provider-data?provider=' + provider.key + '&path=' + encodeURIComponent(path);
}
export function pagination(root) {
  let more = null, cursor = '';
  function walk(v, depth=0) {
    if (!v || Array.isArray(v) || typeof v !== 'object' || depth > 5) return;
    for (const k of ['hasNext','has_next','hasMore','has_more','isMore']) if (v[k] !== undefined && ['boolean','number','string'].includes(typeof v[k])) more = ['true','1'].includes(String(v[k]).toLowerCase());
    for (const k of ['nextToken','next_token','nextCursor','cursor','next']) if (['string','number'].includes(typeof v[k]) && String(v[k]) !== '0') cursor = String(v[k]);
    for (const k of ['data','result','pageInfo','page_info','pagination','meta']) walk(v[k],depth+1);
  }
  walk(root); return {more,cursor};
}
export function mergeItems(old, fresh) {
  const map = new Map(old.map(i=>[i.id,i]));
  for (const i of fresh) {
    const prior=map.get(i.id);map.set(i.id,{...i,feeds:[...new Set([...(prior?.feeds||[]),...(i.feeds||[])])]});
  }
  return [...map.values()];
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const stableItems = items => [...items].sort((a,b)=>a.id.localeCompare(b.id));
