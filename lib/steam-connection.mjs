import steam from '../src/providers/steam/client.js';
import normalize from '../src/providers/steam/normalize.js';
import errors from '../src/shared/providerError.js';

const { ProviderError } = errors;
export const steamIdPattern = /^\d{17}$/;
export const steamKeyPattern = /^[a-f\d]{32}$/i;

const ready = payload => ({ ...payload, status: 'ready', lastSuccessAt: new Date().toISOString() });

export function createSteamConnection({ store, fallback, fetchImpl = fetch }) {
  const active = saved => saved.credentials ?? fallback;
  const sameAccount = (saved, credentials) => credentials && saved.steamId === credentials.steamId;
  const getLibrary = async (client, steamId) => {
    const { games } = normalize.library(await client.library(steamId, client.context(8_000)));
    return ready({ games: games.map(game => ({ ...game, coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}/library_600x900.jpg` })) });
  };
  return {
    async credentials() { return active(await store.read()); },
    async snapshots() {
      const saved = await store.read();
      const credentials = active(saved);
      return sameAccount(saved, credentials)
        ? { library: saved.library ?? { status: 'unavailable' } }
        : { library: { status: credentials ? 'connected' : 'not-configured' } };
    },
    async refresh({ force = false } = {}) {
      return store.locked(async (saved, save) => {
        const credentials = active(saved);
        if (!credentials) return { status: 'not-configured' };
        const now = Date.now();
        const previous = sameAccount(saved, credentials) ? saved : {};
        if (now - (previous.attemptedAt ?? 0) < (force ? 30_000 : 3_300_000)) return { status: previous.library?.status ?? 'connected' };
        const { steamId, apiKey } = credentials;
        const client = steam.createClient({ apiKey, fetchImpl, requestMs: 7_000 });
        let library;
        try { library = await getLibrary(client, steamId); }
        catch {
          library = previous.library?.games
            ? { ...previous.library, status: 'stale', stale: true } : { status: 'unavailable' };
        }
        await save({ ...saved, steamId, attemptedAt: now, library });
        return { status: library.status };
      });
    },
    async configure({ steamId, apiKey }) {
      if (typeof steamId !== 'string' || !steamIdPattern.test(steamId)) throw new ProviderError('invalid-steam-id', 'connection');
      if (typeof apiKey !== 'string' || !steamKeyPattern.test(apiKey)) throw new ProviderError('invalid-steam-key', 'connection');
      return store.locked(async (_state, save) => {
        const client = steam.createClient({ apiKey, fetchImpl, requestMs: 7_000 });
        let library;
        try { library = await getLibrary(client, steamId); }
        catch { throw new ProviderError('steam-library-validation-failed', 'connection'); }
        await save({ credentials: { steamId, apiKey }, steamId, library });
        return { status: 'connected' };
      });
    },
  };
}
