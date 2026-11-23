import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXbox } from '../lib/providers/xbox.mjs';

const nowValue = 1_800_000_000_000;
const xuid = '2533274812345678';
const redirectUri = 'https://example.test/connect.html';
const config = { clientId: '000000004c12ae6f', clientSecret: 'synthetic-secret', redirectUri };

const oauth = {
  token_type: 'bearer', expires_in: 3_600, scope: 'XboxLive.signin XboxLive.offline_access',
  access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', user_id: 'synthetic-user',
};
const userToken = {
  IssueInstant: '2026-01-01T00:00:00Z', NotAfter: '2999-01-01T00:00:00Z', Token: 'synthetic-user-token',
  DisplayClaims: { xui: [{ uhs: 'syntheticuhs' }] },
};
const xsts = {
  IssueInstant: '2026-01-01T00:00:00Z', NotAfter: '2999-01-01T00:00:00Z', Token: 'synthetic-xsts',
  DisplayClaims: { xui: [{ gtg: 'Owner Gamertag', xid: xuid, uhs: 'syntheticuhs' }] },
};
const profile = (id = xuid, gamertag = 'Owner Gamertag') => ({
  profileUsers: [{
    id,
    hostId: id,
    settings: [
      { id: 'Gamertag', value: gamertag },
      { id: 'GameDisplayPicRaw', value: 'https://images-eds-ssl.xboxlive.com/image?url=avatar&format=png' },
      { id: 'Gamerscore', value: '12345' },
    ],
    isSponsoredUser: false,
  }],
});

const titleA = {
  titleId: '1111111111',
  name: 'Series Game',
  type: 'Game',
  devices: ['PC', 'XboxOne', 'XboxSeries'],
  serviceConfigId: 'aaaaaaaa-1111-2222-3333-444444444444',
  displayImage: 'http://store-images.s-microsoft.com/image/apps.series',
  titleHistory: { lastTimePlayed: '2026-05-01T10:00:00.0000000Z', visible: true, canHide: false },
  achievement: { currentAchievements: 2, totalAchievements: 10, currentGamerscore: 20, totalGamerscore: 100 },
};
const titleB = {
  titleId: '2222222222',
  name: 'Legacy Game',
  type: 'Game',
  devices: ['Xbox360'],
  serviceConfigId: null,
  displayImage: 'https://store-images.s-microsoft.com/image/apps.legacy',
  titleHistory: { lastTimePlayed: '2024-01-01T00:00:00.0000000Z', visible: true, canHide: false },
};
const titleC = {
  titleId: '3333333333',
  name: 'Windows Game',
  type: 'Game',
  devices: ['Win32'],
  serviceConfigId: 'bbbbbbbb-1111-2222-3333-444444444444',
  displayImage: 'https://store-images.s-microsoft.com/image/apps.windows',
  titleHistory: { lastTimePlayed: '2025-01-01T00:00:00.0000000Z', visible: true, canHide: false },
};
const appTitle = {
  titleId: '4444444444', name: 'Dashboard', type: 'Application', devices: ['XboxOne'],
  titleHistory: { lastTimePlayed: '2026-06-01T00:00:00Z', visible: true, canHide: false },
};
const hiddenTitle = {
  titleId: '5555555555', name: 'Hidden Game', type: 'Game', devices: ['XboxOne'],
  titleHistory: { lastTimePlayed: '2026-06-01T00:00:00Z', visible: false, canHide: true },
};

const historyResponse = titles => ({ xuid, titles });

const statZero = {
  statlistscollection: [{
    arrangebyfield: 'xuid', arrangebyfieldid: xuid,
    stats: [{ xuid, scid: titleA.serviceConfigId, name: 'MinutesPlayed', type: 'Integer', value: '0', properties: {} }],
  }],
};
const statEmpty = { statlistscollection: [{ arrangebyfield: 'xuid', arrangebyfieldid: xuid, stats: [] }] };
const statBatchLegacy = {
  groups: [{
    name: 'Hero', titleid: titleB.titleId,
    statlistscollection: [{
      arrangebyfield: 'xuid', arrangebyfieldid: xuid,
      stats: [{ xuid, scid: null, name: 'MinutesPlayed', type: 'Integer', value: '45', properties: {} }],
    }],
  }],
};
const statBatchEmpty = { groups: [] };

const achievement = (id, progressState, extra = {}) => ({
  id,
  serviceConfigId: titleA.serviceConfigId,
  name: `Achievement ${id}`,
  titleAssociations: [{ name: titleA.name, id: Number(titleA.titleId) }],
  progressState,
  progression: progressState === 'Achieved' ? { requirements: [], timeUnlocked: '2026-02-01T00:00:00.0000000Z' } : { requirements: [] },
  mediaAssets: [{ name: 'icon.png', type: 'Icon', url: 'http://images-eds.xboxlive.com/image?url=icon' }],
  platforms: ['Durango'],
  isSecret: false,
  description: `Unlocked ${id}`,
  lockedDescription: `Locked ${id}`,
  productId: '00000000-0000-0000-0000-000000000000',
  achievementType: 'Persistent',
  participationType: 'Individual',
  rewards: [{ name: null, description: null, value: '10', type: 'Gamerscore', valueType: 'Int' }],
  isRevoked: false,
  ...extra,
});

const json = (body, status = 200, headers) => Response.json(body, { status, headers });
const statusResponse = (status, headers) => new Response(null, { status, headers });

function queuedFetch(responses, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert(next, `unexpected Xbox request: ${url}`);
    return typeof next === 'function' ? next(url, options) : next;
  };
}

function memoryStore(initial = {}, { busy = false, rejectSave = () => false } = {}) {
  let value = structuredClone(initial);
  let active = false;
  let externalBusy = busy;
  return {
    async read() { return structuredClone(value); },
    async readSnapshot() { return { state: structuredClone(value), busy: active || externalBusy }; },
    setBusy(next) { externalBusy = next; },
    async locked(action) {
      if (active) throw new Error('test store lock is not reentrant');
      active = true;
      try {
        return await action(structuredClone(value), async replacement => {
          if (rejectSave(replacement)) throw new Error('synthetic durable write failure');
          value = structuredClone(replacement);
        });
      } finally { active = false; }
    },
  };
}

function connectedState(overrides = {}) {
  return {
    version: 1,
    status: 'connected',
    xuid,
    gamertag: 'Owner Gamertag',
    identity: { id: 'Owner Gamertag', displayName: 'Owner Gamertag', avatarUrl: null },
    session: {
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
      accessExpiresAt: nowValue + 3_600_000, refreshExpiresAt: null,
      uhs: 'syntheticuhs', xstsToken: 'synthetic-xsts', xstsExpiresAt: nowValue + 3_600_000,
    },
    rotationPending: false,
    retryAt: 0,
    failures: 0,
    ...overrides,
  };
}

async function authorize(adapter) {
  const started = await adapter.start();
  const url = new URL(started.url);
  assert.equal(url.origin, 'https://login.live.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const state = url.searchParams.get('state');
  const callback = `${redirectUri}?code=synthetic-code&state=${state}`;
  return { state, callback };
}

function connectResponses(identity = xuid, gamertag = 'Owner Gamertag') {
  return [json(oauth), json(userToken), json({ ...xsts, DisplayClaims: { xui: [{ ...xsts.DisplayClaims.xui[0], xid: identity }] } }), json(profile(identity, gamertag))];
}

test('the provider stays constructible and readable without OAuth configuration', async () => {
  const store = memoryStore();
  const adapter = createXbox({ store, now: () => nowValue });
  const { library } = await adapter.snapshots();
  assert.equal(library.status, 'not-configured');
  assert.equal(await adapter.identity(), null);
  await assert.rejects(adapter.start(), { code: 'xbox-oauth-not-configured' });
  const invalid = createXbox({ store, now: () => nowValue, ...config, redirectUri: 'http://example.test/connect.html' });
  await assert.rejects(invalid.start(), { code: 'xbox-oauth-not-configured' });
});

test('authorization state and PKCE are stored once with an expiration and validated against the exact callback', async () => {
  const store = memoryStore();
  const adapter = createXbox({ store, fetchImpl: queuedFetch([]), now: () => nowValue, ...config });
  const { callback, state } = await authorize(adapter);
  const pending = (await store.read()).pending;
  assert.equal(pending.state, state);
  assert.equal(pending.redirectUri, redirectUri);
  assert.equal(pending.expiresAt, nowValue + 600_000);
  assert.match(pending.verifier, /^[A-Za-z0-9_-]{43}$/);

  await assert.rejects(adapter.confirm({ callback: `https://evil.test/connect.html?code=x&state=${state}` }), { code: 'invalid-callback' });
  assert.equal((await store.read()).pending.state, state, 'a wrong-origin callback must not consume the pending state');

  await assert.rejects(adapter.confirm({ callback: `${redirectUri}?code=x&state=${'z'.repeat(43)}` }), { code: 'state-mismatch' });
  assert.equal((await store.read()).pending, undefined, 'state mismatch consumes the one-time pending value');
  await assert.rejects(adapter.confirm({ callback }), { code: 'authorization-not-pending' });
});

test('denied authorization and expired pending state fail safely', async () => {
  let time = nowValue;
  const store = memoryStore();
  const adapter = createXbox({ store, fetchImpl: () => assert.fail('denied authorization must not reach upstream'), now: () => time, ...config });
  const { state } = await authorize(adapter);
  await assert.rejects(adapter.confirm({ callback: `${redirectUri}?error=access_denied&state=${state}` }), { code: 'authorization-denied' });

  const started = await adapter.start();
  const nextState = new URL(started.url).searchParams.get('state');
  time += 600_001;
  await assert.rejects(adapter.confirm({ callback: `${redirectUri}?code=synthetic-code&state=${nextState}` }), { code: 'authorization-not-pending' });
  assert.equal((await store.read()).pending, undefined);
});

test('confirmation binds the verified account, persists a session, and never exposes the XUID', async () => {
  const store = memoryStore();
  const calls = [];
  const adapter = createXbox({ store, fetchImpl: queuedFetch(connectResponses(), calls), now: () => nowValue, ...config });
  const { callback } = await authorize(adapter);
  assert.deepEqual(await adapter.confirm({ callback }), { status: 'connected' });

  const saved = await store.read();
  assert.equal(saved.xuid, xuid);
  assert.equal(saved.gamertag, 'Owner Gamertag');
  assert.deepEqual(saved.identity, { id: 'Owner Gamertag', displayName: 'Owner Gamertag', avatarUrl: 'https://images-eds-ssl.xboxlive.com/image?url=avatar&format=png' });
  assert.ok(new URL(calls.at(-1).url).searchParams.get('settings').split(',').includes('GameDisplayPicRaw'));
  assert.equal(saved.session.refreshToken, 'synthetic-refresh');
  assert.equal(saved.session.xstsToken, 'synthetic-xsts');
  assert.equal(saved.pending, undefined);

  const identity = await adapter.identity();
  assert.deepEqual(identity, saved.identity);
  const snapshot = await adapter.snapshots();
  assert.equal(snapshot.library.status, 'unavailable');
  const projection = JSON.stringify({ identity, snapshot });
  for (const secretValue of [xuid, 'synthetic-access', 'synthetic-refresh', 'synthetic-xsts', 'synthetic-user-token', config.clientSecret]) {
    assert.equal(projection.includes(secretValue), false, `projection leaked ${secretValue}`);
  }

  const callsBefore = calls.length;
  await assert.rejects(adapter.confirm({ callback }), { code: 'authorization-not-pending' });
  assert.equal(calls.length, callsBefore);
});

test('reconnecting to a different verified account is rejected while the existing account is bound', async () => {
  const store = memoryStore();
  const adapter = createXbox({ store, fetchImpl: queuedFetch(connectResponses()), now: () => nowValue, ...config });
  const first = await authorize(adapter);
  await adapter.confirm({ callback: first.callback });

  const second = await authorize(adapter);
  const mismatch = createXbox({
    store, now: () => nowValue, ...config,
    fetchImpl: queuedFetch(connectResponses('9999999999999999', 'Other Gamertag')),
  });
  await assert.rejects(mismatch.confirm({ callback: second.callback }), { code: 'owner-account-mismatch' });
  const saved = await store.read();
  assert.equal(saved.xuid, xuid);
  assert.equal(saved.identity.displayName, 'Owner Gamertag');

  assert.deepEqual(await mismatch.disconnect(), { status: 'not-configured' });
  assert.deepEqual(await store.read(), {});
  assert.equal(await mismatch.identity(), null);
});

test('refresh publishes the played-history library with explicit zero, unknown time, and console/platform mapping', async () => {
  const store = memoryStore(connectedState());
  const responses = [
    json(historyResponse([titleA, titleB, titleC, appTitle, hiddenTitle])),
    json(statZero),
    json(statEmpty),
    json(statBatchLegacy),
    json(profile()),
  ];
  const calls = [];
  const adapter = createXbox({ store, fetchImpl: queuedFetch(responses, calls), now: () => nowValue, ...config });
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });

  const { library } = await adapter.snapshots();
  assert.equal(library.status, 'ready');
  assert.equal(library.lastSuccessAt, new Date(nowValue).toISOString());
  assert.equal(library.games.length, 3);
  const byId = Object.fromEntries(library.games.map(game => [game.providerGameId, game]));
  assert.equal(Object.hasOwn(byId, appTitle.titleId), false, 'non-game dashboard records are excluded');
  assert.equal(Object.hasOwn(byId, hiddenTitle.titleId), false, 'hidden Xbox titles must not be republished');

  assert.deepEqual(byId[titleA.titleId], {
    providerGameId: titleA.titleId,
    name: 'Series Game',
    platform: 'xbox-series',
    playtimeMinutes: 0,
    lastPlayedAt: '2026-05-01T10:00:00.000Z',
    imageUrl: 'https://store-images.s-microsoft.com/image/apps.series',
  });
  assert.equal(byId[titleB.titleId].platform, 'xbox-360');
  assert.equal(byId[titleB.titleId].playtimeMinutes, 45);
  assert.equal(byId[titleC.titleId].platform, 'windows');
  assert.equal(byId[titleC.titleId].playtimeMinutes, null);
  assert.equal(calls.some(call => call.url === 'https://userstats.xboxlive.com/batch' && call.options.method === 'POST'), true);
  assert.deepEqual(library.coverage.platforms.sort(), ['windows', 'xbox-360', 'xbox-series']);
  assert.deepEqual(library.totals, {
    recordCount: 3,
    knownRecordPlaytimeMinutes: 45,
    knownPlaytimeRecords: 2,
    unknownPlaytimeRecords: 1,
    unknownPlatformRecords: 0,
  });
  assert.equal(library.coverage.complete, true);
  assert.equal(library.coverage.purchaseLibrary, false);

  const callCount = calls.length;
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  assert.equal(calls.length, callCount, 'non-forced refresh honors the freshness window');
});

test('incomplete title pagination preserves the previous complete library as stale', async () => {
  const store = memoryStore(connectedState());
  const adapter = createXbox({
    store, now: () => nowValue, ...config,
    fetchImpl: queuedFetch([
      json(historyResponse([titleA, titleB, titleC])),
      json(statZero),
      json(statEmpty),
      json(statBatchLegacy),
      json(profile()),
      json({ xuid, titles: [titleA], pagingInfo: { continuationToken: null, totalRecords: 2 } }),
    ]),
  });
  await adapter.refresh();
  const before = (await adapter.snapshots()).library;
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'stale' });
  const after = (await adapter.snapshots()).library;
  assert.equal(after.status, 'stale');
  assert.deepEqual(after.games, before.games);
  assert.equal(after.lastSuccessAt, before.lastSuccessAt);
});

test('rate limiting honors Retry-After and a manual refresh cannot defeat the backoff', async () => {
  const store = memoryStore(connectedState());
  const responses = [
    json(historyResponse([titleA])), json(statZero), json(profile()),
    statusResponse(429, { 'retry-after': '600' }),
  ];
  const calls = [];
  const adapter = createXbox({ store, fetchImpl: queuedFetch(responses, calls), now: () => nowValue, ...config });
  await adapter.refresh();
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'stale' });
  const afterFailure = calls.length;
  const saved = await store.read();
  assert.ok(saved.retryAt >= nowValue + 600_000);
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'stale' });
  assert.equal(calls.length, afterFailure);
});

test('a busy lease during an active rotation still exposes the complete library', async () => {
  const store = memoryStore(connectedState({
    rotationPending: true,
    library: {
      status: 'ready', lastSuccessAt: nowValue,
      payload: { games: [{ providerGameId: titleA.titleId, name: titleA.name, platform: 'xbox-one', playtimeMinutes: null, lastPlayedAt: null, imageUrl: null }] },
    },
  }), { busy: true });
  const adapter = createXbox({ store, fetchImpl: () => assert.fail('snapshot reads must not call upstream'), now: () => nowValue, ...config });
  const { library } = await adapter.snapshots();
  assert.equal(library.status, 'ready');
  assert.equal(library.games.length, 1);
  assert.deepEqual(await adapter.identity(), { id: 'Owner Gamertag', displayName: 'Owner Gamertag', avatarUrl: null });
});

test('an interrupted token rotation is durable and never retries the ambiguous token', async () => {
  let time = nowValue;
  const store = memoryStore(connectedState({
    session: {
      accessToken: 'old-access', refreshToken: 'old-refresh',
      accessExpiresAt: nowValue + 1_000, refreshExpiresAt: null,
      uhs: 'syntheticuhs', xstsToken: 'synthetic-xsts', xstsExpiresAt: nowValue + 3_600_000,
    },
  }));
  const calls = [];
  const adapter = createXbox({ store, fetchImpl: queuedFetch([new Error('connection reset after rotation')], calls), now: () => time, ...config });
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  const saved = await store.read();
  assert.equal(saved.rotationPending, true);
  assert.equal(saved.status, 'reconnect-required');
  assert.equal(saved.session.refreshToken, 'old-refresh');

  const countAfterFailure = calls.length;
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  assert.equal(calls.length, countAfterFailure);
  assert.equal((await adapter.snapshots()).library.status, 'reconnect-required');
  assert.equal(await adapter.identity(), null);
});

test('token rotation persists the replacement refresh token durably before requesting data', async () => {
  const store = memoryStore(connectedState({
    session: {
      accessToken: 'old-access', refreshToken: 'old-refresh',
      accessExpiresAt: nowValue + 1_000, refreshExpiresAt: null,
      uhs: 'syntheticuhs', xstsToken: 'synthetic-xsts', xstsExpiresAt: nowValue + 3_600_000,
    },
  }));
  const replacement = { ...oauth, access_token: 'replacement-access', refresh_token: 'replacement-refresh' };
  const adapter = createXbox({
    store, now: () => nowValue, ...config,
    fetchImpl: queuedFetch([
      json(replacement), json(userToken), json(xsts),
      json(historyResponse([titleA])), json(statZero), json(profile()),
    ]),
  });
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'ready' });
  const saved = await store.read();
  assert.equal(saved.session.accessToken, 'replacement-access');
  assert.equal(saved.session.refreshToken, 'replacement-refresh');
  assert.equal(saved.rotationPending, false);
  assert.ok((await adapter.snapshots()).library.games.length === 1);
});

test('achievement detail is owner-only, paginated, cached, and preserves unknown progress states', async () => {
  const library = {
    status: 'ready', lastSuccessAt: nowValue,
    nextRefreshAt: nowValue + 900_000,
    payload: {
      coverage: { kind: 'played-history', platforms: ['xbox-series'], complete: true, purchaseLibrary: false },
      totals: { recordCount: 1 },
      games: [{ providerGameId: titleA.titleId, name: titleA.name, platform: 'xbox-series', playtimeMinutes: 10, lastPlayedAt: null, imageUrl: null }],
    },
  };
  const store = memoryStore(connectedState({ library }));
  const page1 = {
    achievements: [achievement('1', 'Achieved'), achievement('2', 'NotStarted'), achievement('3', 'InProgress')],
    pagingInfo: { continuationToken: 'next-page', totalRecords: 4 },
  };
  const page2 = {
    achievements: [achievement('4', 'FutureState', { isSecret: true })],
    pagingInfo: { continuationToken: null, totalRecords: 4 },
  };
  const calls = [];
  const adapter = createXbox({ store, fetchImpl: queuedFetch([json(page1), json(page2)], calls), now: () => nowValue, ...config });

  assert.deepEqual(await adapter.detail('9999999999'), { httpStatus: 404, body: { error: 'Game not in the cached Xbox played history' } });
  assert.equal(calls.length, 0, 'unowned IDs must not reach upstream');

  const result = await adapter.detail(titleA.titleId);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.achievementStatus, 'available');
  assert.equal(result.body.stale, undefined);
  const rows = Object.fromEntries(result.body.achievements.map(row => [row.id, row]));
  assert.equal(rows['1'].unlocked, true);
  assert.equal(rows['1'].unlockedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(rows['1'].iconUrl, 'https://images-eds.xboxlive.com/image?url=icon');
  assert.equal(rows['1'].gamerscore, 10);
  assert.equal(rows['2'].unlocked, false);
  assert.equal(rows['2'].unlockedAt, null);
  assert.equal(rows['3'].unlocked, false);
  assert.equal(rows['4'].unlocked, null, 'unrecognized progressState stays unknown');
  assert.equal(rows['4'].hidden, true);
  assert.equal(rows['4'].description, 'Locked 4');

  const callCount = calls.length;
  const cached = await adapter.detail(titleA.titleId);
  assert.equal(calls.length, callCount, 'detail responses are cached for an hour');
  assert.equal(cached.body.achievements.length, 4);
  const cachedSaved = await store.read();
  assert.equal(JSON.stringify(cached.body).includes('synthetic-access'), false);
  assert.equal(JSON.stringify(cachedSaved.details).includes('synthetic-refresh'), false);
});

test('legacy Xbox 360 achievements use the real endpoint and report incompatibility honestly', async () => {
  const library = {
    status: 'ready', lastSuccessAt: nowValue, nextRefreshAt: nowValue + 900_000,
    payload: {
      coverage: { kind: 'played-history', platforms: ['xbox-360'], complete: true, purchaseLibrary: false },
      totals: { recordCount: 1 },
      games: [{ providerGameId: titleB.titleId, name: titleB.name, platform: 'xbox-360', playtimeMinutes: null, lastPlayedAt: null, imageUrl: null }],
    },
  };
  const store = memoryStore(connectedState({ library }));
  const legacyPage = {
    achievements: [
      { id: 1, titleId: Number(titleB.titleId), name: 'Legacy Unlocked', unlocked: true, isSecret: false, gamerscore: 15, imageId: 3, description: 'Done', lockedDescription: 'Do it', timeUnlocked: '2019-01-01T00:00:00.0000000Z' },
      { id: 2, titleId: Number(titleB.titleId), name: 'Legacy Locked', unlocked: false, isSecret: true, gamerscore: 20, imageId: 4, description: 'Done 2', lockedDescription: 'Do it 2', timeUnlocked: '2002-11-15T00:00:00.0000000Z' },
    ],
    pagingInfo: { continuationToken: null, totalRecords: 2 },
  };
  const calls = [];
  const adapter = createXbox({ store, fetchImpl: queuedFetch([json(legacyPage)], calls), now: () => nowValue, ...config });
  const result = await adapter.detail(titleB.titleId);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.achievementStatus, 'available');
  assert.equal(calls[0].url.includes('/titleachievements?'), true);
  assert.deepEqual(result.body.achievements.map(row => [row.id, row.unlocked, row.gamerscore, row.iconUrl, row.rarityPercent]), [
    ['1', true, 15, null, null],
    ['2', false, 20, null, null],
  ]);
  assert.equal(result.body.achievements[1].hidden, true);
  assert.equal(result.body.achievements[1].unlockedAt, null);

  const unsupportedStore = memoryStore(connectedState({ library }));
  const unsupported = createXbox({ store: unsupportedStore, fetchImpl: queuedFetch([statusResponse(404)]), now: () => nowValue, ...config });
  assert.deepEqual(await unsupported.detail(titleB.titleId), { httpStatus: 200, body: { achievementStatus: 'not-supported', achievements: [] } });
});

test('a failed achievement refresh keeps the cached detail and reports it as stale', async () => {
  const library = {
    status: 'ready', lastSuccessAt: nowValue, nextRefreshAt: nowValue + 900_000,
    payload: {
      coverage: { kind: 'played-history', platforms: ['xbox-series'], complete: true, purchaseLibrary: false },
      totals: { recordCount: 1 },
      games: [{ providerGameId: titleA.titleId, name: titleA.name, platform: 'xbox-series', playtimeMinutes: null, lastPlayedAt: null, imageUrl: null }],
    },
  };
  let time = nowValue;
  const state = connectedState({ library });
  state.session.accessExpiresAt = state.session.xstsExpiresAt = nowValue + 7_200_000;
  const store = memoryStore(state);
  const page = { achievements: [achievement('1', 'Achieved')], pagingInfo: { continuationToken: null, totalRecords: 1 } };
  const adapter = createXbox({
    store, now: () => time, ...config,
    fetchImpl: queuedFetch([json(page), new Error('synthetic network failure')]),
  });
  await adapter.detail(titleA.titleId);
  time += 3_600_001;
  const stale = await adapter.detail(titleA.titleId);
  assert.equal(stale.httpStatus, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.achievements.length, 1);
});

test('all visible titles receive playtime updates beyond the first twenty', async () => {
  const titles = Array.from({ length: 26 }, (_, index) => ({
    ...titleA, titleId: String(100 + index), name: `Game ${index}`,
  }));
  const adapter = createXbox({
    store: memoryStore(connectedState()), now: () => nowValue, ...config,
    fetchImpl: async url => {
      if (String(url).includes('titlehub.')) return json(historyResponse(titles));
      if (String(url).includes('userstats.')) return json(statZero);
      return json(profile());
    },
  });
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  const { library } = await adapter.snapshots();
  assert.equal(library.totals.knownPlaytimeRecords, 26);
  assert.equal(library.totals.unknownPlaytimeRecords, 0);
  assert.equal(library.games.find(game => game.providerGameId === '125').playtimeMinutes, 0);
});

test('private achievement responses remove previously public cached unlocks', async () => {
  const library = { status: 'ready', payload: { games: [{
    providerGameId: titleA.titleId, platform: 'xbox-series',
  }] } };
  let time = nowValue;
  const state = connectedState({ library });
  state.session.accessExpiresAt = state.session.xstsExpiresAt = nowValue + 7_200_000;
  const adapter = createXbox({
    store: memoryStore(state), now: () => time, ...config,
    fetchImpl: queuedFetch([
      json({ achievements: [achievement('1', 'Achieved')], pagingInfo: { continuationToken: null } }),
      statusResponse(403),
    ]),
  });
  const first = await adapter.detail(titleA.titleId);
  assert.equal(first.body.achievements[0].gamerscore, 10, 'paging totals are optional');
  time += 3_600_001;
  const privateResult = await adapter.detail(titleA.titleId);
  assert.equal(privateResult.body.achievementStatus, 'private');
  assert.deepEqual(privateResult.body.achievements, []);
  assert.deepEqual((await adapter.detail(titleA.titleId)).body.achievements, []);
});

test('authorization without an offline refresh token cannot become connected', async () => {
  const store = memoryStore();
  const adapter = createXbox({
    store, now: () => nowValue, ...config,
    fetchImpl: queuedFetch([json({ ...oauth, refresh_token: undefined })]),
  });
  const { callback } = await authorize(adapter);
  await assert.rejects(adapter.confirm({ callback }), { code: 'invalid-token-response' });
  assert.equal(await adapter.identity(), null);
});
