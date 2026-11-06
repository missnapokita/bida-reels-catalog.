BIDA REELS CATALOG — SERVER FETCH + RESUME

Use this with the Android Java/ patch in the same package.
This updates your EXISTING Cloudflare catalog admin. No new GitHub admin is needed.
The package is prepared locally; it has not been deployed to your Worker.

INSTALL / UPDATE EXISTING WORKER
1. Replace the matching src/ and test/ files in your catalog Worker project.
   package.json, package-lock.json and wrangler.toml are included for convenience.
   Preserve your existing Worker name, CATALOG R2 bucket, COORDINATOR Durable Object,
   Firebase project, ADMIN_UIDS, secrets and migration history when merging config.
   Do not create a second empty bucket or reset the Durable Object.
2. Run npm ci, then npm test. Expected: 52 tests pass.
3. Configure your provider access code ON THE WORKER:
     npx wrangler secret put PROVIDER_ACCESS_CODE
   Paste the existing provider API key at the interactive prompt.
   Do not paste it into wrangler.toml, Java, a GitHub Pages file or catalog JSON.
4. Run npm run deploy using your existing Cloudflare account.
5. Open the existing catalog admin and sign in. Run Full sync once for the new
   providers and NetShort/DramaWave; later use Resume sync for incomplete feeds.
   Enable the admin's existing automatic update option if you want the configured
   six-hour schedule. This schedule needs an authorized admin refresh session.

FETCH MODES
- With PROVIDER_ACCESS_CODE: the catalog Worker fetches provider metadata directly
  from the server-owned provider registry. DramaBox and BonusTV use x-token;
  the other configured providers use the code query field. Firebase verification
  still applies to admin sessions and Android catalog reads.
- Without that secret: the original authenticated UPSTREAM_GATEWAY mode remains.
- App playback requests still use bida-reels-api. This bundle does not contain
  that gateway's source and cannot repair its provider credential forwarding.

WHAT CHANGED
- Keeps outer pagination metadata and accepts structured provider responses such
  as code:0/data, dramas/videos, and nested JSON strings without requiring an
  invented success:true envelope on every direct response.
- One queued sync per provider, bounded retries/backoff, resumable checkpoints,
  atomic R2 snapshot publication and retention of the last usable metadata.
- NetShort path pagination and DramaWave numeric-next pagination are preserved.
  The page-80 ceiling no longer prematurely stops NetShort. A safety ceiling
  still records an honest partial result and a resumable checkpoint.
- Uses the supplied status API, cached five minutes, to skip maintenance/coming
  providers. If status lookup fails, retains the previous status briefly.
- Handles directory IDs flareflow -> app plerplow and shortswave -> app shortwave.
- Adds the app's FlexTV, Melolo, FlickReels, ShortWave and DramaNova registrations.
  Melolo is explicitly preview-only until its full offset contract is verified.
  PineDrama is documented in PROVIDER_AUDIT.md but is not an app provider yet.

VALIDATION AND LIMITS
52 automated tests passed. Network-dependent tests use fixtures, not live providers.
Previously observed live results and documentation links are in PROVIDER_AUDIT.md;
those are point-in-time observations, not a claim that every API is currently healthy.
ReelShort/FlickReels access-code transport and new provider pagination still need
a deployed-worker smoke test. No code patch can create missing upstream titles.
An active directory label alone does not prove a provider route works.

Published JSON contains title metadata only. Signed video URLs, provider access
codes and admin sessions are not part of the app-readable catalog snapshot.
