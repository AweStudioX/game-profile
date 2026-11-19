# Game Profile

A single-owner game dashboard that runs on Vercel without a database, a worker, or access to another deployment. Steam is the only live provider in this edition. The bundled demo is fictional and exercises cross-platform identity and separate achievement sets.

## Deploy without changing code

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile&project-name=game-profile&repository-name=game-profile)

1. Click **Deploy with Vercel** to copy and deploy the project, or [import your own fork](https://vercel.com/new). Use the repository root and keep the defaults from `vercel.json`.
2. Deploy with no environment variables to try the anonymous demo. To use a real Steam profile, add all three variables in the import form or under **Project → Settings → Environment Variables**. Set the two secrets as **Secret** and scope them to **Production** only, unless you intentionally want the same data in previews.

   | Variable | Value |
   | --- | --- |
   | `STEAM_ID` | Your 17-digit SteamID64, visible in [Steam Account Details](https://store.steampowered.com/account/). |
   | `STEAM_WEB_API_KEY` | Your own [Steam Web API key](https://steamcommunity.com/dev/apikey), registered for your deployment. Secret. |
   | `PROFILE_PASSWORD` | A unique, randomly generated password, 16–120 printable ASCII characters without spaces. Secret, distinct from your Steam password. |

3. If adding or changing variables after deployment, **redeploy**. Open the profile and use **登录查看** with username `owner` and the configured password. Steam controls data visibility: check that Game Details are visible to the API. No credentials are entered into the Game Profile frontend.

## Develop locally

```sh
npm run dev             # Node.js 24; demo by default at http://127.0.0.1:3000
npm test
```

For a local Steam profile, copy `.env.example` to `.env.local` and fill in the values. Restart the local process after changes. Do not commit the local environment file or copy credentials, caches, or configuration from an existing server.

## Privacy and coverage

- With all Steam settings blank the app serves fictional data. With incomplete configuration it serves a setup notice, never live data. With complete configuration, every data endpoint requires owner authentication over HTTPS in production; the shell and a configuration guide are public.
- The server fetches the chosen Steam account's library, current game, and per-game achievements on demand. Library and presence may be cached in function memory for up to five minutes and one minute respectively, per warm instance. There is no durable account store or scheduled synchronization. Personal data responses are not cached by browsers or the CDN. Configure the Vercel function region and document that region for any other users. Assets load directly from Steam CDN.
- Follow the [Steam Web API Terms](https://steamcommunity.com/dev/apiterms). Game Profile is not affiliated with Valve. Provider data is offered as-is, without warranties. No PlayStation or Nintendo online authorization code or real data is shipped in this edition.

## License

MIT; see [LICENSE](LICENSE). The Steam client, normalization, and aggregation modules are derived from [AniketRaj314/gaming-stats-api](https://github.com/AniketRaj314/gaming-stats-api). The original copyright and permission notice are retained.
