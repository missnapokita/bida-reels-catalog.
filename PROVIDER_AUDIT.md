# Provider API audit

Observed in the virtual browser on 6 November 2026. The status response timestamp was 08:12 UTC / 16:12 Philippines time. These are point-in-time observations, not guarantees of future availability.

## Provider directory

The provided API key was used only for the authorized requests. The directory returned `success: true` and 44 platform records: **32 active, 11 maintenance, 1 coming**. The key is not reproduced here.

Maintenance records: Reelala, BiliTV, iDrama, DramaNova, Anyreel, MiniTV, Gold Drama, Bstation, Joyreels, KalosTV, TopDrama. IQIYI was marked coming.

`active` is directory metadata. It is not the result of checking every endpoint. For example, DramaWave was listed active but its documented direct new-drama request returned 404.

## Documentation opened and request details observed

All 18 supplied documentation pages opened successfully in the browser. Endpoint rows below are documentation observations unless a live result is explicitly recorded. Parameters shown are relevant examples, not an exhaustive API schema.

| Provider / documentation | Observed details |
|---|---|
| [StarShort](https://drakula.goodbos.online/starshort-api.html) | `/api/starshort/content/hot`, `locale=en`, `code` query field; hot/latest/trending/recommended are separate feeds. |
| [FlexTV](https://flextv.goodbos.online/api.html) | `/api/drama/home?page=1&lang=en`; normalized popular/newest/list/ranking routes also exist. Documentation uses `lang`, not the app's `_lang` spelling. |
| [DramaBite](https://dramabite.goodbos.online/api.html) | `/module?page=1&lang=en`; `/home` returns home tab information. |
| [DramaBox](https://dramabox.goodbos.online/) | `/api/dramabox/latest`, `/trending`, `/foryou`, `/browse?page=1`; dubbed uses `classify=terpopuler` and page. Requires `x-token`, except languages. |
| [DramaWave](https://dramawave.goodbos.online/api.html) | `/api/new-drama` and `/api/recommend` use numeric `next=1,2,3,...`; new-drama explorer shows `lang`, `code`, `next`. |
| [ShortMax](https://shortmax.goodbos.online/api.html) | `/api/v1/popular?lang=en&page=1&code=...`; new/hot/vip are separate routes. |
| [GoodShort](https://goodshort.goodbos.online/api.html) | `/home?lang=en&channel=-1&page=1&size=20`; search is explicitly labelled as rate limited. |
| [Melolo](https://melolo.goodbos.online/api.html) | `/api/home?lang=en&offset=0&code=...`; response uses `code:0` plus `data`. Offset increment was not verified. |
| [ReelShort](https://reelshort.goodbos.online/api.html) | `/shelf/2009269?page=1&limit=24&lang=en`; other routes are `/trending`, `/home`, `/search`, `/chapters/{id}`, `/allepisodes/{id}`. Access-code UI is present; transport for this provider was not verified. |
| [FlickReels](https://flickreels.goodbos.online/api.html) | Paginated `/api/home`, `/api/list`, `/trending`, `/search`, `/languages`, `/batchload/:id`. Access-code UI is present. |
| [DotDrama](https://dotdrama.goodbos.online/api.html) | `/api/drama/list?lang=en&page=1&limit=18` in explorer; list is paginated. |
| [ShortsWave](https://shortwave.goodbos.online/api.html) | `/api/all?page=1&size=24&lang=en&code=...`, plus `/api/home`. Directory ID is `shortswave`; existing app ID is `shortwave`. |
| [CubeTV](https://cubetv.goodbos.online/api.html) | `/api/home` and `/api/module?lang=en&moduleid=9vb8aR&page=1`; module ID is an example, not a universal catalog identifier. |
| [ReelBuzz](https://reelbuzz.goodbos.online/api.html) | `/api/dramas?offset=0&limit=10&code=...`; separate `/api/search` and `/api/shorts`. |
| [FlareFlow / Plerplow](https://plerplow.goodbos.online/api.html) | Page title is FlareFlow. `/api/trending`, `/api/popular`, `/api/home`, `/api/classes`, `/api/class`; class supports lang, id, page, pageSize, sort, order. Directory ID is `flareflow`; app ID is `plerplow`. |
| [HappyShort](https://happyshort.goodbos.online/api.html) | `/api/hs/home?page=1&size=20&lang=en`; returned both `dramas` and `videos`, plus `has_next`, `page`, `size`, `total`, `total_pages`. |
| [PineDrama](https://pinedrama.goodbos.online/api.html) | API v2. `/home` with code, scene, count, page and lang fields. Scene 1 is all; scene 2 is trending. Not currently registered in the app/catalog. |
| [BonusTV](https://bonustv.goodbos.online/) | `/api/v1/recommend?page=1&lang=en`, home modules/banners/tabs, shorts and search. Requires `x-token`, except health. |

Additional error-related docs opened: [NetShort](https://netshort.goodbos.online/api.html), [FunDrama](https://drakula.goodbos.online/fundrama-api.html), [Velolo](https://velolo.goodbos.online/api.html).

NetShort documents BOTH `/api/home/:page` and `/api/list/:page` as paginated. FunDrama's documented dramas path matches the app. Velolo documents `/home?lang=en&page=1&page_size=20`.

## Read-only live checks

| Request | Browser result |
|---|---|
| StarShort hot, English, supplied code | JSON with `success:true`, `data` containing 10 cards. |
| HappyShort home, English, page 1, size 20 | 20 dramas, `total:484`, `total_pages:25`, `has_next:true`. Duplicate dramas/videos arrays have the same item shape. |
| Melolo home, English, offset 0, supplied code | JSON `code:0`, data includes drama cards and a header entry without a usable cover. |
| DramaWave new-drama, English, next 1, supplied code | Rendered `404 page not found`. Documentation being readable does not prove its API route works. |
| FlareFlow trending, English, supplied code | `{"dramas":[]}`. Empty source data cannot be recovered by adding field aliases. This does not establish the health of its other feeds. |

## What can and cannot be concluded

The earlier 403 failures were specific to the direct clients used here; the virtual browser could open the documentation and several data endpoints. This does not establish that Cloudflare Workers have identical network access.

The catalog's strict `success/data` envelope is the contract with the existing Bida Reels gateway. It should not be loosened merely because direct providers use different formats. The gateway must wrap successful provider responses consistently, forward the correct provider credential, and preserve pagination metadata.

Changing app IDs to directory IDs without reviewing the gateway can break its allowlist, cached series IDs, playback URLs and saved history. Therefore this patch records the `flareflow`/`plerplow` and `shortswave`/`shortwave` mappings without renaming the app IDs.

The provided archives do not contain the actual source of `bida-reels-api`. Its handlers and provider request helpers are still needed for endpoint-level fixes and to verify credential forwarding.

## Integration in this package

This audit records the earlier browser observations. The current Worker adds an optional server-side direct fetch mode, enabled by the PROVIDER_ACCESS_CODE secret. Direct provider payloads have their own validation; the authenticated gateway success/data contract remains unchanged when that mode is not configured. Status-directory aliases are applied without renaming Android provider IDs. See README.txt for deployment and remaining limitations.
