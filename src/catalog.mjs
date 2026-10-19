import aliases from './aliases.mjs';
export function parseJSON(text) {
  // Preserve long provider IDs before JS can round them. Never rewrite inside strings.
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    value => /^-?\d{16,}$/.test(value) ? JSON.stringify(value) : value));
}
export function decodeStructured(value) {
  for (let n = 0; n < 4 && typeof value === 'string'; n++) {
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('"')) break;
    try { const next = parseJSON(text); if (next === value) break; value = next; } catch { break; }
  }
  return value;
}
export function responseShape(raw) {
  const value = decodeStructured(raw);
  if (Array.isArray(value)) return 'array(' + value.length + ')';
  if (!value || typeof value !== 'object') return typeof value;
  const keys = Object.keys(value).filter(k => /^[a-zA-Z_][a-zA-Z0-9_]{0,35}$/.test(k)).slice(0,12);
  const nested = value.data == null ? '' : '; data=' + (Array.isArray(decodeStructured(value.data))
    ? 'array(' + decodeStructured(value.data).length + ')' : typeof decodeStructured(value.data));
  return 'keys=' + keys.join(',') + nested;
}
export function upstreamDetail(body) {
  // Expose useful application errors, never URLs, credentials, or whole payloads.
  let message = typeof body?.message === 'string' ? body.message
    : typeof body?.error === 'string' ? body.error : typeof body?.error?.message === 'string' ? body.error.message : '';
  message = message.replace(/https?:\/\/[^\s]+/gi,'[URL]')
    .replace(/bearer\s+\S+/gi,'Bearer [redacted]')
    .replace(/(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi,'[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g,'[redacted]').replace(/[\r\n\t]+/g,' ').slice(0,180);
  const rawCode = body?.code ?? body?.error?.code;
  const code = ['number','string'].includes(typeof rawCode) && /^[a-zA-Z0-9_.-]{1,35}$/.test(String(rawCode)) ? String(rawCode) : '';
  return [code ? 'code=' + code : '', message].filter(Boolean).join('; ');
}
const field = (o, keys) => {
  for (const k of keys) if (['string','number'].includes(typeof o[k]) && String(o[k]).trim()) return String(o[k]).trim();
  return '';
};
export function sectionKind(label = '') {
  const words = String(label).toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(/ +/);
  return (words.some(w => ['viral','trending','popular','hot'].includes(w)) ? 1 : 0)
    | (words.some(w => ['latest','new','newest','release','releases'].includes(w)) ? 2 : 0);
}
const sectionFields = ['moduleName','moduleTitle','sectionName','sectionTitle','shelfName','shelfTitle','feedName','title','name'];
export function normalize(raw, provider, feed = '', categorySource = feed, rankBase = 0) {
  const found = new Map();
  function walk(value, depth = 0, inherited = sectionKind(categorySource)) {
    if (depth > 12) return;
    value = decodeStructured(value);
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1, inherited); return; }
    if (value.isAdult === true || value.is_adult === true) return;
    const id = field(value, aliases.id), title = field(value, aliases.title);
    let posterUrl = field(value, aliases.posterUrl);
    if (posterUrl.startsWith('//')) posterUrl = 'https:' + posterUrl;
    else if (posterUrl.startsWith('/')) posterUrl = new URL(posterUrl, provider.root).href;
    const card = id && title.length >= 2 && /^https:\/\//.test(posterUrl);
    let kind = inherited;
    if (value.viral === true || value.trendingFeed === true) kind |= 1;
    if (value.newRelease === true || value.latestFeed === true) kind |= 2;
    if (Array.isArray(value.feeds)) for (const f of value.feeds) kind |= sectionKind(f);
    if (!card) for (const key of sectionFields) if (typeof value[key] === 'string') kind |= sectionKind(value[key]);
    if (card) {
      let genre = field(value, aliases.genre);
      if (!genre && Array.isArray(value.tags)) genre = value.tags.map(t => typeof t === 'string' ? t : t.name || t.tagName || '').filter(Boolean).join(', ');
      const rank = rankBase + found.size;
      const item = { id, title, posterUrl, description: field(value, aliases.description),
        genre: genre || 'Short Drama', episodes: Math.max(0, parseInt(field(value, aliases.episodes),10) || 0),
        feeds: feed ? [feed] : [], viral: !!(kind & 1), newRelease: !!(kind & 2),
        viralRank: kind & 1 ? rank : 2147483647, latestRank: kind & 2 ? rank : 2147483647 };
      const old = found.get(id);
      found.set(id, old ? mergeItems([old], [item])[0] : item);
    }
    for (const [key, child] of Object.entries(value)) if (child && (typeof child === 'object' || typeof child === 'string'))
      walk(child, depth + 1, kind | (card ? 0 : sectionKind(key)));
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
export function pagination(root, page = 1) {
  let more = null, cursor = '';
  function walk(v, depth=0) {
    if (depth > 5) return;
    v = decodeStructured(v);
    if (!v || Array.isArray(v) || typeof v !== 'object') return;
    for (const k of ['hasNext','has_next','hasMore','has_more','isMore']) if (v[k] !== undefined && ['true','false','1','0'].includes(String(v[k]).trim().toLowerCase())) more = ['true','1'].includes(String(v[k]).trim().toLowerCase());
    for (const k of ['nextToken','next_token','nextCursor','cursor','next']) if (['string','number'].includes(typeof v[k]) && String(v[k]) !== '0') cursor = String(v[k]);
    if (more === null) {
      const pages = Number(v.totalPages ?? v.total_pages ?? v.pageCount ?? v.last_page);
      const current = Number(v.currentPage ?? v.current_page ?? v.page ?? page);
      if (Number.isFinite(pages) && pages > 0 && Number.isFinite(current) && current > 0) more = current < pages;
      else {
        const total = Number(v.total ?? v.totalCount ?? v.total_count);
        const size = Number(v.pageSize ?? v.page_size ?? v.per_page ?? v.limit);
        if (Number.isFinite(total) && total >= 0 && Number.isFinite(size) && size > 0) more = current * size < total;
      }
    }
    for (const k of ['data','result','pageInfo','page_info','pagination','meta']) walk(v[k],depth+1);
  }
  walk(root); return {more,cursor};
}
export function mergeItems(old, fresh) {
  const map = new Map(old.map(i=>[i.id,i]));
  for (const i of fresh) {
    const prior=map.get(i.id);map.set(i.id,{...i,feeds:[...new Set([...(prior?.feeds||[]),...(i.feeds||[])])],
      viral: !!(prior?.viral || i.viral), newRelease: !!(prior?.newRelease || i.newRelease),
      viralRank: Math.min(prior?.viralRank ?? 2147483647, i.viralRank ?? 2147483647),
      latestRank: Math.min(prior?.latestRank ?? 2147483647, i.latestRank ?? 2147483647)});
  }
  return [...map.values()];
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const stableItems = items => [...items].sort((a,b)=>a.id.localeCompare(b.id));
