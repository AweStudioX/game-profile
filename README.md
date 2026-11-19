# Game Profile

**English** · [简体中文](README.zh-CN.md)

A private, single-owner dashboard for Steam, PlayStation, and Nintendo Switch. Deploy on Vercel, then connect your accounts from the dashboard without editing code.

## Quick start

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile&project-name=game-profile&repository-name=game-profile&env=PROFILE_PASSWORD,PROFILE_ENCRYPTION_KEY&envDescription=Generate%20a%20dashboard%20password%20and%20a%20separate%20encryption%20key.%20See%20the%20setup%20checklist.&envLink=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile%23deployment-checklist&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

On Vercel Hobby, select your **personal GitHub account**, not an organization. Create a Neon database in the deployment wizard, then enter the two secrets below. The integration supplies `DATABASE_URL`.

## Features

- Browse and search a game library with playtime, recent activity, and achievements.
- Switch between Classic and Pixel from the header. Pixel uses a locally hosted [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font) subset for display text; body text and game artwork stay unchanged. The preference is per browser.
- See a game once even when multiple platform records match. Progress remains separate per platform.
- Steam and PlayStation achievements stay separate; Nintendo contributes play history.
- Schedule daily or hourly library sync with [Vercel Schedules (Beta)](https://vercel.com/docs/schedules/limits). Daily is the default (02:00 UTC). The dashboard does not need to stay open.

## Deployment checklist

| Secret | Where to get it |
| --- | --- |
| `PROFILE_PASSWORD` | Generate a unique password in your password manager: 12–120 printable ASCII characters with no spaces (16 or more recommended). The dashboard username is `owner`. |
| `PROFILE_ENCRYPTION_KEY` | Run `openssl rand -hex 32` or generate an equivalent random key with a password manager. Keep the same key across redeploys; a new key cannot decrypt the existing database. Do not reuse your dashboard password. |

After deployment, open **连接平台** (Connect platforms), sign in, and follow the platform instructions. Steam requires a [SteamID64](https://store.steampowered.com/account/) and a [Web API key](https://steamcommunity.com/dev/apikey). PlayStation uses an NPSSO copied from Sony; Nintendo uses a copied callback link. Never enter a platform password on the dashboard.

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

Open <http://127.0.0.1:3000> for the bundled demo. For a private profile, copy [`.env.example`](.env.example) to `.env.local` and configure a dedicated local PostgreSQL database and both secrets. Run `npm test` to verify changes.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The dashboard still shows demo data | Verify the variables are set in Production and redeploy. |
| The connection page cannot open storage | Check `DATABASE_URL` and `PROFILE_ENCRYPTION_KEY`. If reinstalling, use the original encryption key or a new database. |
| Steam data is unavailable | Verify the key and SteamID64, and check that Steam's **Game details** privacy setting allows API access. |

## Privacy

- A real profile's data endpoints require owner sign-in. The page shell and setup guide remain public; personal API responses are not cached by browsers or CDNs.
- Platform credentials and snapshots are encrypted in PostgreSQL. Use a dedicated database per deployment. Artwork loads directly from platform CDNs.
- PlayStation and Nintendo use unofficial interfaces that can break or require reauthorization. The operator is responsible for compliance with platform terms, including the [Steam Web API Terms](https://steamcommunity.com/dev/apiterms). This project is not affiliated with the platforms.

## Contributing

Issues and pull requests are welcome. Include reproduction steps with bug reports, run `npm test` for changes, and keep both README versions in sync. Use fictional data in screenshots and fixtures; never include credentials or personal snapshots.

## License

MIT; see [LICENSE](LICENSE). The Steam client, normalization, and aggregation modules are derived from [AniketRaj314/gaming-stats-api](https://github.com/AniketRaj314/gaming-stats-api). The original copyright and permission notice are retained.
