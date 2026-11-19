import { createHash, timingSafeEqual } from 'node:crypto';
import aggregate from '../src/providers/aggregate/service.js';
import steam from '../src/providers/steam/client.js';
import normalize from '../src/providers/steam/normalize.js';
import providerErrors from '../src/shared/providerError.js';
import { demo } from './demo.mjs';

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

export function createProfile({ env = process.env, fetchImpl = fetch } = {}) {
  const { STEAM_ID: steamId, STEAM_WEB_API_KEY: key, PROFILE_PASSWORD: password } = env;
  const checks = [
    ['STEAM_ID', steamId, /^\d{17}$/],
    ['STEAM_WEB_API_KEY', key, /^[a-f\d]{32}$/i],
    ['PROFILE_PASSWORD', password, /^[\x21-\x7e]{12,120}$/],
  ];
  const issues = Object.fromEntries(checks.flatMap(([name, value, pattern]) =>
    !value ? [[name, 'missing']] : pattern.test(value) ? [] : [[name, 'invalid']]));
  const mode = checks.every(([, value]) => !value) ? 'demo'
    : Object.keys(issues).length ? 'incomplete' : 'private';
  const expected = mode === 'private' ? digest(`owner:${password}`) : null;
  const example = mode === 'demo' ? createAggregateService({ ...demo, registryEntries: [] }) : null;
  const client = mode === 'private' ? createClient({ apiKey: key, fetchImpl, requestMs: 7_000 }) : null;
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

  return async function handle(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...privacyHeaders, Allow: 'GET' } });
    const resource = new URL(request.url).searchParams.get('resource');
    if (resource === 'setup') return json(mode === 'incomplete' ? { mode, issues } : { mode });
    const detailId = resource?.slice(6);
    const detailMatch = resource?.startsWith('games/') && /^[a-z][a-z0-9-]{0,125}$/.test(detailId);
    if (!detailMatch && !['library', 'now-playing', 'login'].includes(resource)) return json({ error: 'not-found' }, 404);
    if (mode === 'incomplete') return json({ error: 'incomplete-config' }, 503);
    if (mode === 'private') {
      const authorization = request.headers.get('authorization');
      const decoded = authorization?.startsWith('Basic ') && authorization.length < 512
        ? Buffer.from(authorization.slice(6), 'base64') : '';
      if (!timingSafeEqual(expected, digest(decoded))) {
        return new Response(null, { status: 401, headers: { ...privacyHeaders,
          ...(resource === 'login' && { 'WWW-Authenticate': 'Basic realm="Game Profile", charset="UTF-8"' }) } });
      }
    }
    if (resource === 'login') return new Response(null, { status: 303, headers: { ...privacyHeaders, Location: '/' } });
    if (example) {
      if (resource === 'library') return json(example.library());
      if (resource === 'now-playing') return json(example.nowPlaying());
      const result = example.game(detailId);
      return json(result.body, result.httpStatus);
    }

    const [cached, profile] = await Promise.all([
      library(), resource === 'now-playing' ? presence() : { status: 'unavailable' },
    ]);
    let progress;
    if (detailMatch) {
      if (!cached.games) return json({ error: 'library-unavailable' }, 503);
      const found = cached.games.find(game => `steam-${game.appId}` === detailId);
      if (!found) return json({ error: 'not-found' }, 404);
      try { progress = found.hasCommunityVisibleStats ? await unlocks(found.appId) : { achievementStatus: 'not-supported' }; }
      catch { progress = { achievementStatus: 'unavailable' }; }
    }
    const service = createAggregateService({ registryEntries: [], steamService: {
      read: type => type === 'library' ? cached : profile,
      game: () => ({ httpStatus: 200, body: progress }),
    } });
    if (resource === 'library') return json(service.library(), cached.status === 'ready' ? 200 : 503);
    if (resource === 'now-playing') return json(service.nowPlaying());
    const result = service.game(detailId);
    return json(result.body, result.httpStatus);
  };
}
