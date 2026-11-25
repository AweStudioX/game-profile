# Game Profile

**English** · [简体中文](README.zh-CN.md)

A public, single-owner game showcase for Steam, PlayStation, Nintendo Switch, Xbox, and Epic Games, with password-protected management. Deploy on Vercel, then connect your accounts without editing code.

## Quick start

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile&project-name=game-profile&repository-name=game-profile&env=PROFILE_PASSWORD,PROFILE_ENCRYPTION_KEY&envDescription=Generate%20a%20dashboard%20password%20and%20a%20separate%20encryption%20key.%20See%20the%20setup%20checklist.&envLink=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile%23deployment-checklist&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

On Vercel Hobby, select your **personal GitHub account**, not an organization. Create a Neon database in the deployment wizard, then enter the two secrets below. The integration supplies `DATABASE_URL`.

## Features

- Browse and search the cover-first game library. Unified platform rows combine player identity, activity, game counts, and sync status without a separate header.
- Classic follows the system light/dark setting until an explicit choice is saved. Footer controls switch color schemes and Classic, Pixel, or Neon City themes; preferences persist per browser. The [Dissolve](https://dissolve.rselmi.com/)-inspired filters, rolling totals, and pagination respect reduced motion.
- Footer stickers use native scroll-driven transform and opacity animations when `ViewTimeline` is available, with a JavaScript fallback for older browsers. Dragged stickers remain independent of the reveal; reduced motion disables it.
- The footer includes 85 hardware, character, and item stickers, now including 2B, Johnny Silverhand, Dante, Cuphead, and Raiden. Desktop/mobile scatter positions shuffle once per page load; dragging and scrolling preserve them. Artwork credits and rights information are listed in [`credits.json`](public/dashboard/stickers/credits.json).
- Drag stickers anywhere on the page with lift, tilt, and edge auto-scroll. Keyboard controls also move stickers; Enter resets their position.
- See a game once even when multiple platform records match. Progress remains separate per platform.
- Steam achievements, PlayStation trophies, and Xbox achievements/Gamerscore stay separate. Nintendo contributes play history; Epic contributes claimed PC base games and reported playtime, not achievements.
- Visitors can browse the dashboard without signing in. Use **登录** (Sign in) to manage connections and choose which platforms' player names, IDs, and available avatars are public. Identity cards default to hidden.
- Schedule daily or hourly library sync with [Vercel Schedules (Beta)](https://vercel.com/docs/schedules/limits). Daily is the default (02:00 UTC). The dashboard does not need to stay open.

## Deployment checklist

| Secret | Where to get it |
| --- | --- |
| `PROFILE_PASSWORD` | Generate a unique password in your password manager: 12–120 printable ASCII characters with no spaces (16 or more recommended). The dashboard username is `owner`. |
| `PROFILE_ENCRYPTION_KEY` | Run `openssl rand -hex 32` or generate an equivalent random key with a password manager. Keep the same key across redeploys; a new key cannot decrypt the existing database. Do not reuse your dashboard password. |

After deployment, open **连接平台** (Connect platforms), sign in, and expand **连接设置与帮助** (Connection settings and help) on a platform card for its credentials and instructions. Sync and disconnect actions stay outside the disclosure. Steam requires a [SteamID64](https://store.steampowered.com/account/) and a [Web API key](https://steamcommunity.com/dev/apikey). PlayStation uses an NPSSO copied from Sony; Nintendo uses a copied callback link. Never enter a platform password on the dashboard.

### Xbox and Epic

Xbox requires your own confidential Microsoft **Web** application:

1. Register an application in the [Microsoft portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), with **Personal Microsoft accounts only**.
2. Add a Web redirect URI matching `https://your-domain/connect.html` exactly. No query or fragment; production requires HTTPS. Registered loopback HTTP redirects are supported for development.
3. Set `XBOX_CLIENT_ID`, `XBOX_CLIENT_SECRET` (the secret **value**, not its ID), and `XBOX_REDIRECT_URI` in Vercel. Track the secret's expiry and redeploy after configuration changes.
4. Sign into the dashboard, expand the Xbox connection settings, and authorize on Microsoft's website. The request sends an S256 PKCE challenge; the server validates the callback state, exchanges the code with its verifier, and the page removes the callback from the address bar before submission.

Xbox reads played-title history, not the complete purchase library; titles marked hidden on Xbox are excluded. Playtime is included only when the title reports `MinutesPlayed`; missing time remains unknown. Supported titles expose achievements and Gamerscore. Older titles may report unsupported achievement data; child accounts, privacy restrictions, and accounts without an Xbox profile can prevent access. Xbox configuration is optional and does not block other providers.

Epic needs no additional environment variables or always-on helper. Generate the official Epic login link in its connection card, sign in on Epic's website, then paste the one-time `authorizationCode` (or the returned JSON). Verify the display name before confirming. Never paste a password or browser cookie.

Epic synchronizes claimed PC base games, including uninstalled games, catalog artwork, and Epic-reported playtime. DLC, Unreal assets, private entries, achievements, recent-play timestamps, and live presence are excluded. Missing or ambiguous time is not converted to zero. The Launcher interface is unofficial and may change. Disconnect first revokes this session; if revocation fails, the local connection is kept so you can retry.

Both providers use the existing encrypted database, scheduled sync, and per-platform identity visibility controls. Xbox exposes Gamertag and an available avatar, never XUID; Epic exposes display name, never account ID or email. No verified Epic avatar is available, so its platform mark is used. Incomplete pagination never replaces a complete saved library.


## Upgrade an existing fork

1. Bring your fork up to date with the template. If it was created from a template rather than forked, merge the upstream changes into your repository; do not create a new Vercel project.
2. In the existing Vercel project, create and connect a dedicated Neon database under **Storage**. Verify that it added `DATABASE_URL` for Production. Add `PROFILE_ENCRYPTION_KEY` in **Settings → Environment Variables** and keep your existing `PROFILE_PASSWORD`.
3. Redeploy Production, then open `/connect.html`. Existing `STEAM_ID` and `STEAM_WEB_API_KEY` still work. Connections saved from the dashboard take precedence. Connect PlayStation and Nintendo again; credentials from other deployments are not copied.

## Local development

Requires Node.js 24.

```sh
git clone https://github.com/AweStudioX/game-profile.git
cd game-profile
npm ci
npm run dev
```

Open <http://127.0.0.1:3000> for the bundled demo. For real records, copy [`.env.example`](.env.example) to `.env.local` and configure a dedicated local PostgreSQL database and both secrets. Run `npm test` to verify changes.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The dashboard still shows demo data | Verify the variables are set in Production and redeploy. |
| The connection page cannot open storage | Check `DATABASE_URL` and `PROFILE_ENCRYPTION_KEY`. If reinstalling, use the original encryption key or a new database. |
| Steam data is unavailable | Verify the key and SteamID64, and check that Steam's **Game details** privacy setting allows API access. |
| PlayStation asks to reconnect | Normal token refresh keeps the saved library visible. An interrupted refresh or failed authorization still requires reconnecting; opening the connection page does not renew authorization. |

## Privacy

- Real game libraries, activity, and achievements are publicly readable. Owner sign-in is required for platform settings and changes; personal API responses are not cached by browsers or CDNs.
- Player identity disclosure is independently controlled per platform and defaults off. Disabled identities are omitted server-side, including avatars. Steam uses SteamID64 and nickname; PlayStation uses Online ID; Nintendo uses the account nickname, not an internal ID, email, or Switch friend code; Xbox uses Gamertag; Epic uses display name only. Missing Steam, PlayStation, and Nintendo avatars are recovered and cached with retry throttling; unavailable images use a neutral person placeholder. Identity error codes remain owner-only.
- Platform credentials and snapshots are encrypted in PostgreSQL. Use a dedicated database per deployment. Artwork loads directly from platform CDNs.
- PlayStation, Nintendo, Xbox, and Epic game data use community integrations that can break or require reauthorization. The operator is responsible for compliance with platform terms, including the [Steam Web API Terms](https://steamcommunity.com/dev/apiterms). This project is not affiliated with the platforms.

## Contributing

Issues and pull requests are welcome. Include reproduction steps with bug reports, run `npm test` for changes, and keep both README versions in sync. Use fictional data in screenshots and fixtures; never include credentials or personal snapshots.

## License

MIT; see [LICENSE](LICENSE). The Steam and Epic client/normalization code and aggregation modules are derived from [AniketRaj314/gaming-stats-api](https://github.com/AniketRaj314/gaming-stats-api). The original copyright and permission notice are retained. Xbox protocol references include [OpenXbox/xbox-webapi-python](https://github.com/OpenXbox/xbox-webapi-python) and [Microsoft's achievement API documentation](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/live/rest/uri/achievements/uri-achievementsusersxuidachievementsgetv2).

The MIT license applies to project code, not third-party sticker artwork. Each asset retains its original rights and any applicable attribution/share-alike conditions; several character images have no free redistribution license. Owning a game or using artwork non-commercially does not itself grant redistribution rights. Check `public/dashboard/stickers/credits.json` and obtain any required permission before reusing artwork.
