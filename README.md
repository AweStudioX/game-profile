# Game Profile

**English** · [简体中文](README.zh-CN.md)

A private, single-owner game dashboard. Deploy on Vercel without a database, a background worker, or code changes. Try it with fictional data, or connect your own Steam account.

## Quick start

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile&project-name=game-profile&repository-name=game-profile&env=STEAM_ID,STEAM_WEB_API_KEY,PROFILE_PASSWORD&envDescription=Enter%20your%20SteamID64%2C%20Steam%20Web%20API%20key%2C%20and%20a%20separate%20dashboard%20password.&envLink=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile%23connect-steam)

Vercel asks for all three [Steam setup variables](#connect-steam) before deploying. On Vercel Hobby, choose your personal GitHub account rather than a GitHub organization as the destination.

## Features

- Browse and search a game library with playtime, recent activity, and achievements.
- See a game once even when multiple platform records match. Progress remains separate per platform.
- Run with **Steam** as the live source. PlayStation and Nintendo Switch appear only in the bundled demo; live sync is not included.

## Connect Steam

Get the three values below before clicking **Deploy with Vercel**. In Vercel, choose your GitHub destination and enter the values in the **Environment Variables** step before clicking **Deploy**. The form’s help link returns to this checklist.

| Variable | Where to get it |
| --- | --- |
| `STEAM_ID` | Sign in to [Steam Account Details](https://store.steampowered.com/account/) and copy the **17-digit Steam ID** shown under your account name. Do not use your nickname or a custom profile URL. |
| `STEAM_WEB_API_KEY` | Sign in to the [Steam Web API Key page](https://steamcommunity.com/dev/apikey). Copy your registered key or register one for the hostname you intend to use. Paste only the key into Vercel, not the domain name. Save it as **Secret** wherever Vercel offers the option. |
| `PROFILE_PASSWORD` | Generate a new password in your password manager: 16–120 printable ASCII characters, no spaces. This is the password for the game dashboard, not one issued by Steam or Vercel. Save it as **Secret** wherever Vercel offers the option. |

After deployment, open the site, select **登录查看** (Sign in), and use `owner` with `PROFILE_PASSWORD`. If you deployed the demo first, imported a fork, or need to rotate a key, use **Project → Settings → Environment Variables**, then redeploy. Keep credentials scoped to **Production** unless you intend to use them in previews.

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
