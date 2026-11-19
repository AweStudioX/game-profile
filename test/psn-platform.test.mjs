import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPsn } from '../lib/providers/psn.mjs';

const nowValue = 1_800_000_000_000;
const npsso = 'N'.repeat(64);
const session = {
  access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
  expires_in: 3_600, refresh_token_expires_in: 86_400,
};
const summary = { accountId: '12345678901234567890', trophyLevel: '105', earnedTrophies: { bronze: 1, silver: 0, gold: 0, platinum: 0 } };
const title = { titleId: 'PPSA12345_00', name: 'Fixture Game', category: 'ps5_native_game', playDuration: 'PT2H', playCount: 2,
  imageUrl: 'https://image.api.playstation.com/game.png', concept: { id: '12345' } };
const trophyList = { npCommunicationId: 'NPWR12345_00', npServiceName: 'trophy2', trophyTitleName: 'Fixture Trophies',
  trophyTitlePlatform: 'PS5', hiddenFlag: false, progress: 25,
  earnedTrophies: { bronze: 1, silver: 0, gold: 0, platinum: 0 }, definedTrophies: { bronze: 2, silver: 0, gold: 0, platinum: 0 } };
const definition = { trophyId: 1, trophyName: 'First trophy', trophyDetail: 'Earn it.', trophyHidden: false, trophyType: 'bronze',
  trophyIconUrl: 'https://image.api.playstation.com/trophy.png' };

const json = (body, status = 200, headers) => Response.json(body, { status, headers });
const authorization = () => [
  new Response(null, { status: 302, headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?code=synthetic-code' } }),
  json(session), json(summary), json({ onlineId: 'Owner_123', isMe: true }),
];

function queuedFetch(responses, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert(next, `unexpected PSN request: ${url}`);
    return typeof next === 'function' ? next(url, options) : next;
  };
}

function memoryStore(initial = {}, rejectSave = () => false) {
  let value = structuredClone(initial);
  let active = false;
  return {
    async read() { return structuredClone(value); },
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

async function connect({ responses = authorization(), store = memoryStore(), calls = [], now = () => nowValue } = {}) {
  const adapter = createPsn({ store, fetchImpl: queuedFetch(responses, calls), now });
  const identified = await adapter.identify({ npsso });
  assert.equal(identified.onlineId, 'Owner_123');
  assert.match(identified.confirmationId, /^[A-Za-z0-9_-]{20,}$/);
  return { adapter, store, calls, identified };
}

test('NPSSO identification persists only a short-lived verified session and confirmation is single-use', async () => {
  const { adapter, store, identified } = await connect();
  const pending = await store.read();
  assert.equal(pending.pending.onlineId, 'Owner_123');
  assert.equal(pending.pending.accountId, summary.accountId);
  assert.equal(JSON.stringify(pending).includes(npsso), false);
  assert.equal(JSON.stringify(pending).includes('synthetic-refresh'), true);

  await assert.rejects(adapter.confirm({ confirmationId: 'wrong-confirmation' }), { code: 'confirmation-expired' });
  assert.deepEqual(await adapter.confirm({ confirmationId: identified.confirmationId }), { status: 'connected' });
  await assert.rejects(adapter.confirm({ confirmationId: identified.confirmationId }), { code: 'confirmation-expired' });
  const saved = await store.read();
  assert.equal(saved.pending, undefined);
  assert.equal(saved.onlineId, 'Owner_123');
  assert.equal(saved.accountId, summary.accountId);
  assert.equal(JSON.stringify(saved).includes(npsso), false);
});

test('an existing binding accepts only the same verified account until disconnect', async () => {
  const first = await connect();
  await first.adapter.confirm({ confirmationId: first.identified.confirmationId });
  const wrongIdentity = [
    ...authorization().slice(0, 2), json({ ...summary, accountId: '999' }), json({ onlineId: 'OtherOwner', isMe: true }),
  ];
  const second = createPsn({ store: first.store, fetchImpl: queuedFetch(wrongIdentity), now: () => nowValue });
  await assert.rejects(second.identify({ npsso }), { code: 'disconnect-before-reconnecting' });

  assert.deepEqual(await second.disconnect(), { status: 'not-configured' });
  const replacementResponses = [
    ...authorization().slice(0, 2), json({ ...summary, accountId: '999' }), json({ onlineId: 'OtherOwner', isMe: true }),
  ];
  const replacement = createPsn({ store: first.store, fetchImpl: queuedFetch(replacementResponses), now: () => nowValue });
  const identified = await replacement.identify({ npsso });
  assert.equal(identified.onlineId, 'OtherOwner');
});

test('refresh publishes bounded service-shaped snapshots and throttles non-forced calls', async () => {
  const responses = [...authorization(),
    json({ titles: [title], totalItemCount: 1, nextOffset: null }),
    json({ trophyTitles: [trophyList], totalItemCount: 1, nextOffset: null }),
    json(summary),
    json({ basicPresence: { primaryPlatformInfo: { onlineStatus: 'online', platform: 'PS5' }, gameTitleInfoList: [
      { npTitleId: title.titleId, titleName: title.name, format: 'PS5' },
    ] } }),
  ];
  const calls = [];
  const { adapter, identified } = await connect({ responses, calls });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  const snapshots = await adapter.snapshots();
  assert.equal(snapshots.library.status, 'ready');
  assert.equal(snapshots.library.lastSuccessAt, new Date(nowValue).toISOString());
  assert.equal(snapshots.library.games.length, 1);
  assert.equal(snapshots.library.games[0].providerGameId, title.titleId);
  assert.equal(snapshots.library.games[0].name, title.name);
  assert.equal(snapshots.presence.status, 'ready');
  assert.equal(snapshots.presence.activity, 'playing');
  assert.equal(snapshots.presence.online, true);
  assert.equal(snapshots.presence.lastSuccessAt, new Date(nowValue).toISOString());
  const callCount = calls.length;
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  assert.equal(calls.length, callCount);
});

test('transient refresh failure preserves the library and never republishes stale presence as playing', async () => {
  let time = nowValue;
  const responses = [...authorization(),
    json({ titles: [title], totalItemCount: 1, nextOffset: null }),
    json({ trophyTitles: [trophyList], totalItemCount: 1, nextOffset: null }), json(summary),
    json({ basicPresence: { primaryPlatformInfo: { onlineStatus: 'online', platform: 'PS5' }, gameTitleInfoList: [] } }),
    new Error('synthetic network secret'),
  ];
  const { adapter, store, identified } = await connect({ responses, now: () => time });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await adapter.refresh();
  time += 91_000;
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'stale' });
  const snapshots = await adapter.snapshots();
  assert.equal(snapshots.library.status, 'stale');
  assert.equal(snapshots.library.games[0].providerGameId, title.titleId);
  assert.deepEqual(snapshots.presence, { status: 'unavailable', lastSuccessAt: new Date(nowValue).toISOString(), activity: 'unavailable', online: null, platform: null, games: [] });
  assert.equal(JSON.stringify(await store.read()).includes('synthetic network secret'), false);
});

test('an interrupted refresh-token rotation is durable and never retries the ambiguous token', async () => {
  let time = nowValue;
  const responses = [...authorization(), new Error('connection reset after token rotation')];
  const calls = [];
  const { adapter, store, identified } = await connect({ responses, calls, now: () => time });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await store.locked(async (state, save) => {
    state.session.accessExpiresAt = time + 1_000;
    await save(state);
  });
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  const countAfterFailure = calls.length;
  assert.equal((await store.read()).rotationPending, true);
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  assert.equal(calls.length, countAfterFailure);
  assert.equal((await adapter.snapshots()).library.status, 'reconnect-required');
});

test('a failed durable write after token issuance leaves the rotation marker and old token unusable', async () => {
  const replacement = { access_token: 'replacement-access', refresh_token: 'replacement-refresh', expires_in: 3_600, refresh_token_expires_in: 86_400 };
  let rejectReplacement = false;
  const store = memoryStore({}, state => rejectReplacement && state.session?.accessToken === 'replacement-access' && state.rotationPending === false);
  const calls = [];
  const { adapter, identified } = await connect({ responses: [...authorization(), json(replacement)], calls, store });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await store.locked(async (state, save) => {
    state.session.accessExpiresAt = nowValue + 1_000;
    await save(state);
  });
  rejectReplacement = true;
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  const failed = await store.read();
  assert.equal(failed.rotationPending, true);
  assert.equal(failed.session.refreshToken, 'synthetic-refresh');
  const countAfterFailure = calls.length;
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  assert.equal(calls.length, countAfterFailure);
});

test('detail rejects unowned IDs without upstream work and maps visible trophy definitions with earned data', async () => {
  const responses = [...authorization(),
    json({ titles: [title], totalItemCount: 1, nextOffset: null }),
    json({ trophyTitles: [trophyList], totalItemCount: 1, nextOffset: null }), json(summary),
    json({ basicPresence: { primaryPlatformInfo: { onlineStatus: 'offline', platform: 'PS5' } } }),
    json({ titles: [{ npTitleId: title.titleId, trophyTitles: [{ npCommunicationId: trophyList.npCommunicationId }] }] }),
    json({ trophies: [definition], totalItemCount: 1, nextOffset: null }),
    json({ trophies: [{ trophyId: 1, earned: true, earnedDateTime: '2026-01-01T00:00:00Z', trophyEarnedRate: '2.5' }], totalItemCount: 1, nextOffset: null }),
  ];
  const calls = [];
  const { adapter, identified } = await connect({ responses, calls });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await adapter.refresh();
  const before = calls.length;
  assert.deepEqual(await adapter.detail('PPSA99999_00'), { httpStatus: 404, body: { error: 'Game not in the cached PSN played history' } });
  assert.equal(calls.length, before);
  const result = await adapter.detail(title.titleId);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.trophyStatus, 'available');
  assert.equal(result.body.trophySets[0].trophies[0].name, 'First trophy');
  assert.equal(result.body.trophySets[0].trophies[0].earned, true);
  assert.equal(result.body.trophySets[0].trophies[0].earnedRate, 2.5);
});
