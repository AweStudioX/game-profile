import { createHash, timingSafeEqual } from 'node:crypto';
import aggregate from '../src/providers/aggregate/service.js';
import steam from '../src/providers/steam/client.js';
import normalize from '../src/providers/steam/normalize.js';
import providerErrors from '../src/shared/providerError.js';
import { demo } from './demo.mjs';
import { platformRoutes, platformSnapshots, readIdentities } from './platform-routes.mjs';
import { steamIdPattern, steamKeyPattern } from './steam-connection.mjs';

const { createAggregateService } = aggregate;
const { createClient } = steam;
const { safeError } = providerErrors;
const privacyHeaders = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200) => Response.json(body, { status, headers: privacyHeaders });
const digest = value => createHash('sha256').update(value).digest();
const ready = data => ({ ...data, status: 'ready', lastSuccessAt: new Date().toISOString() });
const unavailable = error => ({ status: ['game-achievements:forbidden', 'profile:forbidden', 'library:private-or-invalid-response'].includes(safeError(error)) ? 'private' : 'unavailable' });

function memoizeSnapshot(load, ttl) {
  let pending;
  let until = 0;
  return () => {
    if (!pending || until && Date.now() >= until) {
      until = 0;
      pending = load().then(result => {
        until = Date.now() + (result.status === 'ready' ? ttl : 15_000);
        return result;
      });
    }
    return pending;
  };
}

const noSteam = async () => ({ status: 'not-configured' });

function createSteamReader({ steamId, apiKey }, fetchImpl) {
  const client = createClient({ apiKey, fetchImpl, requestMs: 7_000 });
  const library = memoizeSnapshot(async () => {
    try {
      const { games } = normalize.library(await client.library(steamId, client.context(8_000)));
      return ready({ games: games.map(game => ({ ...game, coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appId}/library_600x900.jpg` })) });
    } catch (error) { return unavailable(error); }
  }, 300_000);
  const presence = memoizeSnapshot(async () => {
    try {
      const profile = normalize.profile(await client.profile(steamId, client.context(8_000)), null, steamId);
      return ready({ currentGame: profile.currentGame });
    } catch (error) { return unavailable(error); }
  }, 60_000);

  async function unlocks(appId) {
    const ctx = client.context(8_000);
    const [schema, achievements, rarity] = await Promise.allSettled([
      client.schema(appId, undefined, ctx), client.achievements(steamId, appId, undefined, ctx), client.globalAchievements(appId, ctx),
    ]);
    return normalize.details({ schemaRaw: schema.value, achievementsRaw: achievements.value, globalRaw: rarity.value, failures: {
      ...(schema.status === 'rejected' && { schema: safeError(schema.reason) }),
      ...(achievements.status === 'rejected' && { achievements: safeError(achievements.reason) }),
    } });
  }

  return { library, presence, unlocks };
}

export function createProfile({ env = process.env, fetchImpl = fetch, platforms = {}, syncSettings,
  storageStatus = Object.keys(platforms).length ? 'configured' : 'not-configured' } = {}) {
  const { STEAM_ID: steamId, STEAM_WEB_API_KEY: apiKey, PROFILE_PASSWORD: password } = env;
  const checks = [
    ['STEAM_ID', steamId, steamIdPattern],
    ['STEAM_WEB_API_KEY', apiKey, steamKeyPattern],
    ['PROFILE_PASSWORD', password, /^[\x21-\x7e]{12,120}$/],
  ];
  const issues = Object.fromEntries(checks.flatMap(([name, value, pattern]) =>
    !value ? [[name, 'missing']] : pattern.test(value) ? [] : [[name, 'invalid']]));
  // An installed database enables in-app connection even before Steam is configured.
  if (platforms.steam) {
    delete issues.STEAM_ID;
    delete issues.STEAM_WEB_API_KEY;
  }
  const mode = checks.every(([, value]) => !value) && !platforms.steam ? 'demo'
    : Object.keys(issues).length ? 'incomplete' : 'private';
  const expected = mode === 'private' ? digest(`owner:${password}`) : null;
  const example = mode === 'demo' ? createAggregateService({ ...demo, registryEntries: [] }) : null;
  const fallback = steamIdPattern.test(steamId ?? '') && steamKeyPattern.test(apiKey ?? '') ? { steamId, apiKey } : null;
  const fallbackReader = fallback ? createSteamReader(fallback, fetchImpl) : { library: noSteam, presence: noSteam };
  let savedReader;
  let savedIdentity;
  let savedKey;
  async function steamReader() {
    if (!platforms.steam) return fallbackReader;
    let saved;
    try { saved = await platforms.steam.credentials(); }
    catch { return fallback ? fallbackReader : { library: async () => ({ status: 'unavailable' }), presence: noSteam }; }
    if (!saved) return fallbackReader;
    if (saved.steamId !== savedIdentity || saved.apiKey !== savedKey) {
      savedReader = createSteamReader(saved, fetchImpl);
      savedIdentity = saved.steamId;
      savedKey = saved.apiKey;
    }
    return savedReader;
  }

  return async function handle(request) {
    const resource = new URL(request.url).searchParams.get('resource');
    const method = resource === 'platform-action' ? 'POST' : 'GET';
    if (request.method !== method) return new Response(null, { status: 405, headers: { ...privacyHeaders, Allow: method } });
    if (resource === 'setup') return json(mode === 'incomplete' ? { mode, issues } : { mode });
    const platformRequest = resource === 'platforms' || resource === 'platform-action';
    const detailId = resource?.slice(6);
    const detailMatch = resource?.startsWith('games/') && /^[a-z][a-z0-9-]{0,125}$/.test(detailId);
    const login = resource === 'login' || resource === 'connect-login';
    if (!platformRequest && !detailMatch && !login && !['library', 'now-playing', 'identities', 'session'].includes(resource)) return json({ error: 'not-found' }, 404);
    if (resource === 'session' && mode !== 'private') return json({ authenticated: false });
    if (mode === 'incomplete') return json({ error: 'incomplete-config' }, 503);
    if (mode === 'private' && (platformRequest || login || resource === 'session')) {
      const authorization = request.headers.get('authorization');
      const decoded = authorization?.startsWith('Basic ') && authorization.length < 512
        ? Buffer.from(authorization.slice(6), 'base64') : '';
      const authenticated = timingSafeEqual(expected, digest(decoded));
      if (resource === 'session') return json({ authenticated });
      if (!authenticated) {
        return new Response(null, { status: 401, headers: { ...privacyHeaders,
          ...(login && { 'WWW-Authenticate': 'Basic realm="Game Profile", charset="UTF-8"' }) } });
      }
    }
    if (platformRequest) return mode === 'private' ? platformRoutes(request, resource, platforms, storageStatus, syncSettings)
      : json({ error: 'owner-not-configured' }, 403);
    if (login) return new Response(null, { status: 303, headers: { ...privacyHeaders, Location: resource === 'connect-login' ? '/connect.html' : '/' } });
    if (resource === 'identities') {
      if (example) return json({ identities: {
        steam: { id: null, displayName: 'Demo Player', avatarUrl: null },
        psn: { id: 'DemoPlayer', displayName: 'DemoPlayer', avatarUrl: null },
        nintendo: { id: null, displayName: 'Demo Player', avatarUrl: null },
      } });
      let visibility;
      try { visibility = (await syncSettings?.status())?.identityVisibility; }
      catch { return json({ identities: {} }); }
      return json({ identities: visibility ? await readIdentities(platforms, visibility) : {} });
    }
    if (example) {
      if (resource === 'library') return json(example.library());
      if (resource === 'now-playing') return json(example.nowPlaying());
      const result = example.game(detailId);
      return json(result.body, result.httpStatus);
    }

    const snapshots = await platformSnapshots(platforms, { live: resource === 'now-playing' });
    const reader = await steamReader();
    const cached = snapshots.steam?.library?.games ? snapshots.steam.library : await reader.library();
    const profile = resource === 'now-playing' ? await reader.presence() : { status: 'unavailable' };
    const psnDetails = new Map();
    let steamProgress;
    const service = createAggregateService({
      registryEntries: [],
      steamService: {
        read: type => type === 'library' ? cached : profile,
        game: () => ({ httpStatus: 200, body: steamProgress }),
      },
      psnService: snapshots.psn && {
        read: type => snapshots.psn[type] ?? { status: 'unavailable' },
        game: id => psnDetails.get(id) ?? { httpStatus: 503 },
      },
      nintendoService: snapshots.nintendo && { read: () => snapshots.nintendo.library },
    });
    if (resource === 'library') {
      const result = service.library();
      return json(result, result.status === 'unavailable' && !platforms.steam ? 503 : 200);
    }
    if (resource === 'now-playing') return json(service.nowPlaying());

    const found = service.library().games.find(game => game.id === detailId);
    if (!found) return json({ error: 'not-found' }, 404);
    const observations = found.editions.flatMap(edition => edition.copies).flatMap(copy => copy.observations);
    const steamGame = observations.find(observation => observation.provider === 'steam')?.data;
    await Promise.all([
      (async () => {
        try {
          steamProgress = steamGame?.hasCommunityVisibleStats ? await reader.unlocks(steamGame.appId) : { achievementStatus: 'not-supported' };
        } catch { steamProgress = { achievementStatus: 'unavailable' }; }
      })(),
      (async () => {
        for (const { provider, providerGameId } of observations) {
          if (provider !== 'psn' || psnDetails.has(providerGameId)) continue;
          try { psnDetails.set(providerGameId, await platforms.psn.detail(providerGameId)); }
          catch { psnDetails.set(providerGameId, { httpStatus: 503 }); }
        }
      })(),
    ]);
    const result = service.game(detailId);
    return json(result.body, result.httpStatus);
  };
}
