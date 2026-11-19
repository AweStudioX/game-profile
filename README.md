# Game Profile

**English** · [简体中文](README.zh-CN.md)

A private, single-owner game dashboard. Deploy on Vercel without a database, a background worker, or code changes. Try it with fictional data, or connect your own Steam account.

## Quick start

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile&project-name=game-profile&repository-name=game-profile)

1. Click **Deploy with Vercel**, or fork this repository and [import your fork](https://vercel.com/new). Keep the repository root and the defaults in `vercel.json`.
2. Leave all environment variables blank to try the fictional demo. For real data, follow [Connect Steam](#connect-steam).

## Features

- Browse and search a game library with playtime, recent activity, and achievements.
- See a game once even when multiple platform records match. Progress remains separate per platform.
- Run with **Steam** as the live source. PlayStation and Nintendo Switch appear only in the bundled demo; live sync is not included.

## Connect Steam

Add all three variables in the Vercel setup form or **Project → Settings → Environment Variables**. Keep real credentials scoped to **Production** unless you also intend to use them in previews.

| Variable | Value |
| --- | --- |
| `STEAM_ID` | Your 17-digit SteamID64 from [Steam Account Details](https://store.steampowered.com/account/). |
| `STEAM_WEB_API_KEY` | [Your own Steam Web API key](https://steamcommunity.com/dev/apikey). Save as **Secret**. |
| `PROFILE_PASSWORD` | A randomly generated password, 16–120 printable ASCII characters with no spaces. Save as **Secret**. Do not reuse your Steam password. |

Redeploy after adding or changing the variables. On the dashboard, select **登录查看** (Sign in) and use `owner` with `PROFILE_PASSWORD`. No Steam credentials are entered into the dashboard.

## Local development

Requires Node.js 24.

```sh
git clone https://github.com/AweStudioX/game-profile.git
cd game-profile
npm run dev
```

Open <http://127.0.0.1:3000>. For a local Steam profile, copy [`.env.example`](.env.example) to `.env.local`, fill in all three values, and restart the server. Run `npm test` to verify changes.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The dashboard still shows demo data | Check the environment scope and redeploy. |
| The dashboard says setup is incomplete | Set all three variables and check their formats. |
| Steam data is unavailable | Verify the key and SteamID64, and check that Steam's **Game details** privacy setting allows API access. |

## Privacy

- A real profile's data endpoints require owner sign-in. The page shell and setup guide remain public; personal API responses are not cached by browsers or CDNs.
- Library and activity snapshots are kept in function memory for up to five minutes and one minute, respectively, per warm instance. There is no database or scheduled sync. Artwork loads directly from Steam's CDN.
- The deployment operator is responsible for their configuration, data processing region, and compliance with the [Steam Web API Terms](https://steamcommunity.com/dev/apiterms). This project is not affiliated with Valve.

## Contributing

Issues and pull requests are welcome. Include reproduction steps with bug reports, run `npm test` for changes, and keep both README versions in sync. Use fictional data in screenshots and fixtures; never include credentials or personal snapshots.

## License

MIT; see [LICENSE](LICENSE). The Steam client, normalization, and aggregation modules are derived from [AniketRaj314/gaming-stats-api](https://github.com/AniketRaj314/gaming-stats-api). The original copyright and permission notice are retained.
