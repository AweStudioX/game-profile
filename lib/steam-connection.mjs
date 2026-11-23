import steam from '../src/providers/steam/client.js';
import normalize from '../src/providers/steam/normalize.js';
import errors from '../src/shared/providerError.js';

const { ProviderError } = errors;
export const steamIdPattern = /^\d{17}$/;
export const steamKeyPattern = /^[a-f\d]{32}$/i;

const ready = payload => ({ ...payload, status: 'ready', lastSuccessAt: new Date().toISOString() });

// Only re-expose avatars from hosts that normalize.profile already trusts.
const avatarHosts = new Set([
  'avatars.akamai.steamstatic.com', 'avatars.fastly.steamstatic.com', 'avatars.cloudflare.steamstatic.com',
  'avatars.steamstatic.com', 'steamcdn-a.akamaihd.net',
]);
const safeAvatar = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && avatarHosts.has(url.hostname) ? url.href : null;
  } catch { return null; }
};
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value) ? value : null;
const identityOf = (profile, steamId) => ({
  id: steamId,
  displayName: safeName(profile?.personaName),
  avatarUrl: safeAvatar(profile?.avatarUrl),
});
const storedIdentity = (saved, steamId) => saved?.identity
  ? { id: steamId, displayName: safeName(saved.identity.displayName), avatarUrl: safeAvatar(saved.identity.avatarUrl) }
  : null;

export function createSteamConnection({ store, fallback, fetchImpl = fetch }) {
  const active = saved => saved.credentials ?? fallback;
  const sameAccount = (saved, credentials) => credentials && saved.steamId === credentials.steamId;
  const getLibrary = async (client, steamId) => {
    const { games } = normalize.library(await client.library(steamId, client.context(8_000)));
    return ready({ games: games.map(game => ({ ...game, coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}/library_600x900.jpg` })) });
  };
  // Identity is optional: any profile failure must leave the library path intact.
  const getIdentity = async (client, steamId) => {
    try { return identityOf(normalize.profile(await client.profile(steamId, client.context(8_000)), null, steamId), steamId); }
    catch { return null; }
  };
  return {
    async credentials() { return active(await store.read()); },
    async identity() {
      const saved = await store.read();
      const credentials = active(saved);
      if (!credentials) return null;
      if (!sameAccount(saved, credentials)) return { id: credentials.steamId, displayName: null, avatarUrl: null };
      return storedIdentity(saved, credentials.steamId) ?? { id: credentials.steamId, displayName: null, avatarUrl: null };
    },
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
        // A changed account can never inherit the previous account's identity.
        const identity = (await getIdentity(client, steamId)) ?? storedIdentity(previous, steamId);
        await save({ ...saved, steamId, attemptedAt: now, library, identity });
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
        // Fall back to the verified account id when the profile endpoint is unavailable.
        const identity = (await getIdentity(client, steamId)) ?? { id: steamId, displayName: null, avatarUrl: null };
        await save({ credentials: { steamId, apiKey }, steamId, library, identity });
        return { status: 'connected' };
      });
    },
  };
}
