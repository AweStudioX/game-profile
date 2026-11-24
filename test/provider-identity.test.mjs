import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSteamConnection } from '../lib/steam-connection.mjs';
import { createPsn } from '../lib/providers/psn.mjs';
import { createNintendo } from '../lib/providers/nintendo.mjs';
import psnNormalize from '../src/providers/psn/normalize.js';

const steamId = '76561198000000000';
const otherSteamId = '76561198000000001';
const apiKey = 'a'.repeat(32);
const trustedAvatar = 'https://avatars.akamai.steamstatic.com/player.jpg';

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  return {
    async read() { return structuredClone(state); },
    async readSnapshot() { return { state: structuredClone(state), busy: false }; },
    async locked(action) { return action(structuredClone(state), async next => { state = structuredClone(next); }); },
  };
}

const json = (body, status = 200) => Response.json(body, { status });

test('Steam identity exposes only verified profile fields', async () => {
  const fetchImpl = async url => {
    const path = new URL(String(url)).pathname;
    if (path.includes('GetOwnedGames')) return json({ response: { game_count: 1, games: [{ appid: 101, name: 'Example Game' }] } });
    if (path.includes('GetPlayerSummaries')) {
      return json({ response: { players: [{ steamid: steamId, personaname: 'Kai', avatarfull: trustedAvatar }] } });
    }
    assert.fail(`unexpected Steam endpoint: ${url}`);
  };
  const store = memoryStore();
  const adapter = createSteamConnection({ store, fetchImpl });
  assert.equal((await adapter.configure({ steamId, apiKey })).status, 'connected');
  assert.deepEqual(await adapter.identity(), { id: steamId, displayName: 'Kai', avatarUrl: trustedAvatar });
  assert.deepEqual(Object.keys(await adapter.identity()).sort(), ['avatarUrl', 'displayName', 'id']);
});

test('Steam identity rejects untrusted avatars without breaking the library', async () => {
  const fetchImpl = async url => {
    const path = new URL(String(url)).pathname;
    if (path.includes('GetOwnedGames')) return json({ response: { game_count: 1, games: [{ appid: 101, name: 'Example Game' }] } });
    if (path.includes('GetPlayerSummaries')) {
      return json({ response: { players: [{ steamid: steamId, personaname: 'Kai', avatarfull: 'https://evil.example/avatar.jpg' }] } });
    }
    assert.fail(`unexpected Steam endpoint: ${url}`);
  };
  const store = memoryStore();
  const adapter = createSteamConnection({ store, fetchImpl });
  assert.equal((await adapter.configure({ steamId, apiKey })).status, 'connected');
  assert.equal((await adapter.snapshots()).library.status, 'ready');
  assert.deepEqual(await adapter.identity(), { id: steamId, displayName: 'Kai', avatarUrl: null });
});

test('Steam profile outage preserves successful configuration and library refresh', async () => {
  const adapter = createSteamConnection({ store: memoryStore(), fetchImpl: async url => {
    if (new URL(url).pathname.includes('GetOwnedGames')) {
      return json({ response: { game_count: 1, games: [{ appid: 101, name: 'Example Game' }] } });
    }
    return new Response(null, { status: 503 });
  } });
  assert.equal((await adapter.configure({ steamId, apiKey })).status, 'connected');
  assert.equal((await adapter.refresh({ force: true })).status, 'ready');
  assert.deepEqual(await adapter.identity(), { id: steamId, displayName: null, avatarUrl: null });
  assert.equal((await adapter.snapshots()).library.games[0].name, 'Example Game');
});

test('Steam retries missing profile identity and caches the nickname and avatar', async () => {
  const store = memoryStore({ credentials: { steamId, apiKey }, steamId,
    identity: { id: steamId, displayName: null, avatarUrl: null } });
  let requests = 0;
  const adapter = createSteamConnection({ store, fetchImpl: async url => {
    assert.match(String(url), /GetPlayerSummaries/);
    requests++;
    return json({ response: { players: [{ steamid: steamId, personaname: 'Kai', avatarfull: trustedAvatar }] } });
  } });
  assert.deepEqual(await adapter.identity(), { id: steamId, displayName: 'Kai', avatarUrl: trustedAvatar });
  assert.deepEqual(await adapter.identity(), { id: steamId, displayName: 'Kai', avatarUrl: trustedAvatar });
  assert.equal(requests, 1);
});

test('Steam never serves a cached identity from a different account', async () => {
  const store = memoryStore({
    credentials: { steamId: otherSteamId, apiKey },
    steamId: otherSteamId,
    identity: { id: otherSteamId, displayName: 'Old Player', avatarUrl: trustedAvatar },
    library: { status: 'ready', games: [] },
  });
  const adapter = createSteamConnection({ store, fetchImpl: () => assert.fail('identity reads must not fetch') });
  assert.deepEqual(await adapter.identity(), { id: otherSteamId, displayName: 'Old Player', avatarUrl: trustedAvatar });

  // The fallback credentials belong to a different account than the persisted identity.
  const fallback = createSteamConnection({
    store: memoryStore({ steamId: otherSteamId, identity: { id: otherSteamId, displayName: 'Old Player', avatarUrl: trustedAvatar } }),
    fallback: { steamId, apiKey },
    fetchImpl: () => assert.fail('identity reads must not fetch'),
  });
  assert.deepEqual(await fallback.identity(), { id: steamId, displayName: null, avatarUrl: null });
});

const psnSession = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3_600, refresh_token_expires_in: 86_400 };
const psnSummary = { accountId: '12345678901234567890', trophyLevel: '1', earnedTrophies: { bronze: 0, silver: 0, gold: 0, platinum: 0 } };
const psnProfile = {
  onlineId: 'Owner_123', isMe: true,
  avatars: [
    { size: 's', url: 'https://evil.example/avatar.png' },
    { size: 'm', url: 'https://image.api.playstation.com/avatar-m.png' },
    { size: 'xl', url: 'https://static-resource.np.community.playstation.net/avatar_xl/WW/owner.png' },
  ],
};
const psnTitle = { titleId: 'PPSA12345_00', name: 'Fixture Game', category: 'ps5_native_game', playDuration: 'PT2H' };

function queuedFetch(responses) {
  return async url => {
    const next = responses.shift();
    assert(next, `unexpected PSN request: ${url}`);
    return typeof next === 'function' ? next() : next;
  };
}

test('PSN selects the largest trusted avatar and keeps it across confirmation', async () => {
  const responses = [
    new Response(null, { status: 302, headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?code=synthetic-code' } }),
    json(psnSession), json(psnSummary), json(psnProfile),
  ];
  const store = memoryStore();
  const adapter = createPsn({ store, fetchImpl: queuedFetch(responses), now: () => 1_000_000 });
  assert.equal((await adapter.identity()), null);
  const identified = await adapter.identify({ npsso: 'N'.repeat(64) });
  assert.equal(identified.onlineId, 'Owner_123');
  assert.equal((await store.read()).pending.avatarUrl, psnProfile.avatars[2].url);
  await adapter.confirm({ confirmationId: identified.confirmationId });
  assert.deepEqual(await adapter.identity(), {
    id: 'Owner_123', displayName: 'Owner_123', avatarUrl: psnProfile.avatars[2].url,
  });
  assert.deepEqual(await adapter.disconnect(), { status: 'not-configured' });
  assert.equal(await adapter.identity(), null);
});

test('PSN retries a missing avatar without changing the stored nickname', async () => {
  const store = memoryStore({
    version: 1, status: 'connected', onlineId: 'Owner_123', accountId: psnSummary.accountId,
    identity: { id: 'Owner_123', displayName: 'Owner_123', avatarUrl: null },
    session: { ...psnSession, accessExpiresAt: 2_000_000, refreshExpiresAt: 3_000_000 },
  });
  const profile = { ...psnProfile, avatars: psnProfile.avatars.map(row => ({ ...row, url: row.url.replace('https:', 'http:') })) };
  const adapter = createPsn({ store, fetchImpl: queuedFetch([json(profile)]), now: () => 1_000_000 });
  assert.deepEqual(await adapter.identity(), {
    id: 'Owner_123', displayName: 'Owner_123', avatarUrl: psnProfile.avatars[2].url,
  });
  assert.deepEqual(await adapter.identity(), {
    id: 'Owner_123', displayName: 'Owner_123', avatarUrl: psnProfile.avatars[2].url,
  });
});

test('PSN only upgrades HTTP avatars from the known legacy CDN', () => {
  const host = 'static-resource.np.community.playstation.net';
  assert.equal(psnNormalize.safeAvatarUrl(`http://${host}/avatar/player.png`), `https://${host}/avatar/player.png`);
  for (const url of [
    'http://image.api.playstation.com/player.png',
    `http://${host}.evil.example/player.png`,
    `http://user:password@${host}/player.png`,
    `http://${host}:8080/player.png`,
    `http://${host}/player.png#fragment`,
    `ftp://${host}/player.png`,
  ]) assert.equal(psnNormalize.safeAvatarUrl(url), null, url);
});

test('PSN profile failure during refresh keeps the library ready and preserves the cached avatar', async () => {
  const cachedAvatar = 'https://image.api.playstation.com/cached.png';
  const store = memoryStore({
    version: 1, status: 'connected', onlineId: 'Owner_123', accountId: psnSummary.accountId,
    identity: { id: 'Owner_123', displayName: 'Owner_123', avatarUrl: cachedAvatar },
    session: { ...psnSession, accessExpiresAt: 2_000_000, refreshExpiresAt: 3_000_000 },
    library: { status: 'ready', payload: { games: [] }, lastSuccessAt: 1_000_000, nextRefreshAt: 0 },
    presence: { status: 'ready', payload: { activity: 'offline', online: false, platform: null, games: [] }, lastSuccessAt: 1_000_000, nextRefreshAt: 9_999_999_999 },
  });
  const responses = [
    json({ titles: [psnTitle], totalItemCount: 1, nextOffset: null }),
    json({ trophyTitles: [], totalItemCount: 0, nextOffset: null }),
    json(psnSummary),
    new Response(null, { status: 500 }),
  ];
  const adapter = createPsn({ store, fetchImpl: queuedFetch(responses), now: () => 1_000_000 });
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  assert.equal((await adapter.snapshots()).library.status, 'ready');
  assert.deepEqual(await adapter.identity(), { id: 'Owner_123', displayName: 'Owner_123', avatarUrl: cachedAvatar });
});

const nintendoHistory = { playHistories: [{ titleId: '0100ABC', titleName: 'Synthetic Adventure', platform: 'Nintendo Switch', totalPlayedMinutes: 75 }] };
const nintendoProfile = {
  nickname: 'Zeke', screenName: 'private-screen-name', email: 'private@example.test', id: 'internal-account-id',
  mii: { id: 'mii-id_1', etag: 'etag-value', imageOrigin: 'cdn-mii.accounts.nintendo.com' },
};
const nintendoAvatar = 'https://cdn-mii.accounts.nintendo.com/1.0.0/miis/mii-id_1/image/etag-value.png?width=128';

function nintendoFetch(responses) {
  return async url => {
    const href = String(url);
    if (href.endsWith('/api/session_token')) return json({ session_token: 'durable-session-secret' });
    if (href.endsWith('/api/token')) return json({ access_token: 'short-access-secret', id_token: 'short-id-secret' });
    const next = responses.shift();
    assert(next, `unexpected Nintendo request: ${href}`);
    return typeof next === 'function' ? next() : next;
  };
}

test('Nintendo exposes only nickname and the constructed Mii image during confirm', async () => {
  const store = memoryStore();
  const adapter = createNintendo({ store, fetchImpl: nintendoFetch([json(nintendoHistory), json(nintendoProfile)]), now: () => 1_000_000 });
  const { url } = await adapter.start();
  const state = new URL(url).searchParams.get('state');
  const callback = `npf5c38e31cd085304b://auth#session_token_code=synthetic-code&state=${encodeURIComponent(state)}`;
  assert.deepEqual(await adapter.confirm({ callback }), { status: 'ready' });
  const identity = await adapter.identity();
  assert.deepEqual(identity, { id: null, displayName: 'Zeke', avatarUrl: nintendoAvatar });
  const serialized = JSON.stringify(identity);
  for (const secret of ['private-screen-name', 'private@example.test', 'internal-account-id']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('Nintendo retries a missing avatar while preserving its nickname', async () => {
  const store = memoryStore({
    version: 1, sessionToken: 'durable-session-secret', lastAttemptAt: '2020-01-01T00:00:00.000Z', failureCode: null,
    identity: { id: null, displayName: 'Zeke', avatarUrl: null },
  });
  const adapter = createNintendo({ store, fetchImpl: nintendoFetch([json(nintendoProfile)]), now: () => 1_000_000 });
  assert.deepEqual(await adapter.identity(), { id: null, displayName: 'Zeke', avatarUrl: nintendoAvatar });
  assert.deepEqual(await adapter.identity(), { id: null, displayName: 'Zeke', avatarUrl: nintendoAvatar });
});

test('Nintendo prefers and caches a trusted iconUri with or without a Mii', async () => {
  for (const host of ['cdn.accounts.nintendo.com', 'cdn-mii.accounts.nintendo.com']) {
    for (const mii of [null, nintendoProfile.mii]) {
      const iconUri = `https://${host}/profile/fixture.png`;
      const store = memoryStore({ version: 1, sessionToken: 'durable-session-secret' });
      const adapter = createNintendo({
        store,
        fetchImpl: nintendoFetch([json({ ...nintendoProfile, iconUri, mii })]),
        now: () => 1_000_000,
      });
      const expected = { id: null, displayName: 'Zeke', avatarUrl: iconUri };
      assert.deepEqual(await adapter.identity(), expected);
      assert.deepEqual(await adapter.identity(), expected);
    }
  }
});

test('Nintendo rejects unsafe iconUri values and falls back only to a trusted Mii', async () => {
  for (const iconUri of [
    'https://evil.example/player.png',
    'https://cdn.accounts.nintendo.com.evil.example/player.png',
    'http://cdn.accounts.nintendo.com/player.png',
    'https://user:password@cdn.accounts.nintendo.com/player.png',
    'https://cdn.accounts.nintendo.com:8080/player.png',
    'https://cdn.accounts.nintendo.com/player.png#fragment',
  ]) {
    for (const mii of [null, nintendoProfile.mii]) {
      const store = memoryStore({ version: 1, sessionToken: 'durable-session-secret' });
      const adapter = createNintendo({
        store,
        fetchImpl: nintendoFetch([json({ ...nintendoProfile, iconUri, mii })]),
        now: () => 1_000_000,
      });
      assert.deepEqual(await adapter.identity(), {
        id: null, displayName: 'Zeke', avatarUrl: mii ? nintendoAvatar : null,
      });
    }
  }
});

test('Nintendo profile failure does not break a successful history refresh', async () => {
  const store = memoryStore({
    version: 1, sessionToken: 'durable-session-secret', lastAttemptAt: '2020-01-01T00:00:00.000Z', failureCode: null,
    identity: { id: null, displayName: 'Cached', avatarUrl: nintendoAvatar },
  });
  const adapter = createNintendo({
    store,
    fetchImpl: nintendoFetch([json(nintendoHistory), new Response(null, { status: 403 })]),
    now: () => 1_000_000,
  });
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'ready' });
  assert.equal((await adapter.snapshots()).library.status, 'ready');
  assert.deepEqual(await adapter.identity(), { id: null, displayName: 'Cached', avatarUrl: nintendoAvatar });
});

test('Nintendo rejects Mii images from any other host', async () => {
  const store = memoryStore({ version: 1, sessionToken: 'durable-session-secret', lastAttemptAt: '2020-01-01T00:00:00.000Z', failureCode: null });
  const adapter = createNintendo({
    store,
    fetchImpl: nintendoFetch([
      json(nintendoHistory),
      json({ nickname: 'Zeke', mii: { id: 'mii', etag: 'etag', imageOrigin: 'evil.example', imageUri: 'https://evil.example/a.png' } }),
    ]),
    now: () => 1_000_000,
  });
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'ready' });
  assert.deepEqual(await adapter.identity(), { id: null, displayName: 'Zeke', avatarUrl: null });
});

test('Nintendo profile uses the access token even when history requires the ID token', async () => {
  const store = memoryStore({ sessionToken: 'saved-session' });
  const adapter = createNintendo({ store, fetchImpl: async (url, options) => {
    if (String(url).endsWith('/api/token')) return json({ access_token: 'access-secret', id_token: 'id-secret' });
    if (String(url).endsWith('/play_histories')) {
      return options.headers.Authorization === 'Bearer id-secret' ? json(nintendoHistory) : json({}, 401);
    }
    assert.equal(String(url), 'https://api.accounts.nintendo.com/2.0.0/users/me');
    return options.headers.Authorization === 'Bearer access-secret' ? json(nintendoProfile) : json({}, 401);
  } });
  assert.equal((await adapter.refresh({ force: true })).status, 'ready');
  assert.equal((await adapter.identity()).displayName, 'Zeke');
});
