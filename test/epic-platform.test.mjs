import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEpic } from '../lib/providers/epic.mjs';

const nowValue = 1_800_000_000_000;
const code = 'synthetic-epic-code';
const accountId = 'a'.repeat(32);
const otherAccountId = 'b'.repeat(32);
const session = {
  access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
  expires_in: 3_600, refresh_token_expires_in: 86_400,
  account_id: accountId, displayName: 'OwnerPlayer',
};
const verify = { account_id: accountId, displayName: 'OwnerPlayer', email: 'owner@example.test' };

const baseItem = { namespace: 'ns1', catalogItemId: 'base1', appName: 'App1', sandboxType: 'PUBLIC' };
const dlcItem = { namespace: 'ns1', catalogItemId: 'dlc1', appName: 'AppDlc', sandboxType: 'PUBLIC' };
const engineItem = { namespace: 'ue', catalogItemId: 'engine1', appName: 'UE', sandboxType: 'PUBLIC' };
const privateItem = { namespace: 'ns2', catalogItemId: 'private1', appName: 'Priv', sandboxType: 'PRIVATE' };
const libraryPage = { records: [baseItem, dlcItem, engineItem, privateItem], responseMetadata: { nextCursor: null } };
const baseCatalog = {
  title: 'Fixture Base', categories: [{ path: 'games' }, { path: 'games/edition/base' }],
  keyImages: [{ type: 'DieselGameBoxWide', url: 'https://cdn1.epicgames.com/base.png', width: 600, height: 400 }],
};
const dlcCatalog = {
  title: 'Fixture DLC', categories: [{ path: 'games' }, { path: 'games/addons' }],
  mainGameItem: { id: 'base1' }, keyImages: [],
};
const catalogResponse = { base1: baseCatalog, dlc1: dlcCatalog };
const playtimeResponse = [
  { accountId, artifactId: 'App1', totalTime: 3_600 },
  { accountId, artifactId: 'AppDlc', totalTime: 120 },
];

const json = (body, status = 200, headers) => Response.json(body, { status, headers });
const authSequence = () => [json(session), json(verify)];

function queuedFetch(responses, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert(next, `unexpected Epic request: ${url}`);
    return typeof next === 'function' ? next(url, options) : next;
  };
}

function memoryStore(initial = {}, rejectSave = () => false) {
  let value = structuredClone(initial);
  let active = false;
  return {
    async read() { return structuredClone(value); },
    async readSnapshot() { return { state: structuredClone(value), busy: active }; },
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

async function connect({ responses = authSequence(), store = memoryStore(), calls = [], now = () => nowValue } = {}) {
  const adapter = createEpic({ store, fetchImpl: queuedFetch(responses, calls), now });
  const identified = await adapter.identify({ authorizationCode: code });
  assert.equal(identified.displayName, 'OwnerPlayer');
  assert.match(identified.confirmationId, /^[A-Za-z0-9_-]{20,}$/);
  return { adapter, store, calls, responses, identified };
}

function connectedState(overrides = {}) {
  return {
    version: 1, status: 'connected', accountId, displayName: 'OwnerPlayer',
    identity: { id: null, displayName: 'OwnerPlayer', avatarUrl: null },
    session: { accessToken: 'old-access', refreshToken: 'old-refresh', accountId, displayName: 'OwnerPlayer',
      accessExpiresAt: nowValue + 3_600_000, refreshExpiresAt: nowValue + 86_400_000 },
    rotationPending: false, retryAt: 0, failures: 0,
    catalog: {},
    ...overrides,
  };
}

test('start exposes only the official one-time-code sign-in URL', () => {
  const adapter = createEpic({ store: memoryStore(), fetchImpl: () => assert.fail('start must not call upstream') });
  const { url } = adapter.start();
  const login = new URL(url);
  assert.equal(login.origin, 'https://www.epicgames.com');
  assert.equal(login.pathname, '/id/login');
  const redirect = new URL(login.searchParams.get('redirectUrl'));
  assert.equal(redirect.origin, 'https://www.epicgames.com');
  assert.equal(redirect.pathname, '/id/api/redirect');
  assert.equal(redirect.searchParams.get('clientId'), '34a02cf8f4414e29b15921876da36f9a');
  assert.equal(redirect.searchParams.get('responseType'), 'code');
});

test('authorization codes are validated and the pending session expires after a short window', async () => {
  const invalid = createEpic({ store: memoryStore(), fetchImpl: () => assert.fail('invalid input must not call upstream') });
  await assert.rejects(invalid.identify({ authorizationCode: 'not a valid code' }), { code: 'invalid-authorization-code' });
  await assert.rejects(invalid.identify({}), { code: 'invalid-authorization-code' });

  let time = nowValue;
  const { adapter, store, identified } = await connect({ now: () => time });
  const pending = await store.read();
  assert.equal(pending.pending.accountId, accountId);
  assert.equal(JSON.stringify(pending).includes(code), false);
  assert.equal(await adapter.identity(), null);

  time += 5 * 60 * 1_000 + 1;
  await assert.rejects(adapter.confirm({ confirmationId: 'wrong-confirmation' }), { code: 'confirmation-expired' });
  await assert.rejects(adapter.confirm({ confirmationId: identified.confirmationId }), { code: 'confirmation-expired' });
  assert.equal((await store.read()).pending, undefined);
});

test('Epic JSON authorization codes are accepted and confirmation is single-use', async () => {
  const adapter = createEpic({ store: memoryStore(), fetchImpl: queuedFetch(authSequence()), now: () => nowValue });
  const identified = await adapter.identify({ authorizationCode: JSON.stringify({ authorizationCode: code }) });
  assert.equal(identified.displayName, 'OwnerPlayer');
  assert.deepEqual(await adapter.confirm({ confirmationId: identified.confirmationId }), { status: 'connected' });
  await assert.rejects(adapter.confirm({ confirmationId: identified.confirmationId }), { code: 'confirmation-expired' });

  let time = nowValue;
  const expiring = await connect({ now: () => time });
  time += 5 * 60 * 1_000 + 1;
  await assert.rejects(expiring.adapter.confirm({ confirmationId: expiring.identified.confirmationId }), { code: 'confirmation-expired' });
  assert.equal((await expiring.store.read()).pending, undefined);
});

test('a connected owner is not switched silently and reconnection must match the bound account', async () => {
  const first = await connect();
  await first.adapter.confirm({ confirmationId: first.identified.confirmationId });
  const locked = createEpic({ store: first.store, fetchImpl: () => assert.fail('must reject before upstream'), now: () => nowValue });
  await assert.rejects(locked.identify({ authorizationCode: code }), { code: 'disconnect-before-reconnecting' });

  const reconnecting = memoryStore({ status: 'reconnect-required', accountId, displayName: 'OwnerPlayer' });
  const otherSession = { ...session, access_token: 'other-access', refresh_token: 'other-refresh', account_id: otherAccountId, displayName: 'OtherOwner' };
  const mismatch = createEpic({ store: reconnecting, fetchImpl: queuedFetch([json(otherSession)]), now: () => nowValue });
  await assert.rejects(mismatch.identify({ authorizationCode: code }), { code: 'owner-account-mismatch' });
  assert.equal((await reconnecting.read()).pending, undefined);

  const revocation = createEpic({ store: first.store, fetchImpl: queuedFetch([new Response(null, { status: 204 })]), now: () => nowValue });
  assert.deepEqual(await revocation.disconnect(), { status: 'not-configured' });
  const otherVerify = { account_id: otherAccountId, displayName: 'OtherOwner' };
  const replacement = createEpic({ store: first.store, fetchImpl: queuedFetch([json(otherSession), json(otherVerify)]), now: () => nowValue });
  assert.equal((await replacement.identify({ authorizationCode: code })).displayName, 'OtherOwner');
});

test('refresh publishes a complete base-game library with cached catalog and playtime', async () => {
  const responses = [...authSequence(), json(libraryPage), json(catalogResponse), json(playtimeResponse)];
  const calls = [];
  const { adapter, identified } = await connect({ responses, calls });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });

  const snapshots = await adapter.snapshots();
  const library = snapshots.library;
  assert.equal(library.status, 'ready');
  assert.equal(library.lastSuccessAt, new Date(nowValue).toISOString());
  assert.equal(library.games.length, 1);
  assert.equal(library.games[0].name, 'Fixture Base');
  assert.equal(library.games[0].playtimeMinutes, 60);
  assert.equal(library.games[0].playtimeStatus, 'known');
  assert.equal(library.games[0].lastPlayedAt, null);
  assert.equal(library.games[0].artwork.url, 'https://cdn1.epicgames.com/base.png');
  assert.equal(library.coverage.excluded.addons, 1);
  assert.equal(library.coverage.excluded.engineAssets, 1);
  assert.equal(library.coverage.excluded.privateRecords, 1);
  assert.equal(library.coverage.catalogStale, false);
  assert.equal(JSON.stringify(snapshots).includes('synthetic-access'), false);
  assert.equal(JSON.stringify(snapshots).includes('synthetic-refresh'), false);

  const callCount = calls.length;
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  assert.equal(calls.length, callCount);
});

test('complete library pagination merges every page before publishing', async () => {
  const pageOne = { records: [baseItem], responseMetadata: { nextCursor: 'page-2' } };
  const secondItem = { namespace: 'ns1', catalogItemId: 'base2', appName: 'App2', sandboxType: 'PUBLIC' };
  const pageTwo = { records: [secondItem], responseMetadata: { nextCursor: null } };
  const catalog = {
    base1: { title: 'Fixture Base', categories: [{ path: 'games' }], keyImages: [] },
    base2: { title: 'Second Base', categories: [{ path: 'games/edition/base' }], keyImages: [] },
  };
  const responses = [...authSequence(), json(pageOne), json(pageTwo), json(catalog), json([])];
  const calls = [];
  const { adapter, identified } = await connect({ responses, calls });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  const library = (await adapter.snapshots()).library;
  assert.deepEqual(library.games.map(game => game.name).sort(), ['Fixture Base', 'Second Base']);
  assert.equal(library.coverage.inventoryComplete, true);
  assert.equal(calls.filter(call => call.url.includes('/library/api/public/items')).length, 2);
});

test('explicit zero playtime is known while a missing record stays unknown', async () => {
  const records = [
    { namespace: 'ns1', catalogItemId: 'zero1', appName: 'ZeroApp', sandboxType: 'PUBLIC' },
    { namespace: 'ns1', catalogItemId: 'unknown1', appName: 'UnknownApp', sandboxType: 'PUBLIC' },
  ];
  const catalog = {
    zero1: { title: 'Zero Game', categories: [{ path: 'games' }], keyImages: [] },
    unknown1: { title: 'Unknown Game', categories: [{ path: 'games/edition/base' }], keyImages: [] },
  };
  const responses = [...authSequence(), json({ records, responseMetadata: { nextCursor: null } }), json(catalog),
    json([{ accountId, artifactId: 'ZeroApp', totalTime: 0 }])];
  const { adapter, identified } = await connect({ responses });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  const library = (await adapter.snapshots()).library;
  const zero = library.games.find(game => game.name === 'Zero Game');
  const unknown = library.games.find(game => game.name === 'Unknown Game');
  assert.equal(zero.playtimeMinutes, 0);
  assert.equal(zero.playtimeStatus, 'known');
  assert.equal(unknown.playtimeMinutes, null);
  assert.equal(unknown.playtimeStatus, 'unknown');
  assert.equal(library.totals.knownPlaytimeGameCount, 1);
  assert.equal(library.totals.unknownPlaytimeGameCount, 1);
});

test('an interrupted token rotation stays durable and is never retried', async () => {
  let time = nowValue;
  const calls = [];
  const { adapter, store, responses, identified } = await connect({ calls, now: () => time });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await store.locked(async (state, save) => {
    state.session.accessExpiresAt = time + 1_000;
    await save(state);
  });
  responses.push(new Error('connection reset after token rotation'));

  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  const failed = await store.read();
  assert.equal(failed.rotationPending, true);
  assert.equal(failed.status, 'reconnect-required');
  const callCount = calls.length;
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  assert.equal(calls.length, callCount);
  assert.equal((await adapter.snapshots()).library.status, 'reconnect-required');
});

test('a failed durable write after rotation keeps the marker and the old token unusable', async () => {
  const rotated = { ...session, access_token: 'replacement-access', refresh_token: 'replacement-refresh' };
  let rejectReplacement = false;
  const store = memoryStore({}, state => rejectReplacement &&
    state.session?.accessToken === 'replacement-access' && state.rotationPending === false);
  const calls = [];
  const responses = authSequence();
  const { adapter, identified } = await connect({ responses, store, calls });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await store.locked(async (state, save) => {
    state.session.accessExpiresAt = nowValue + 1_000;
    await save(state);
  });
  responses.push(json(rotated));
  rejectReplacement = true;

  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  const failed = await store.read();
  assert.equal(failed.rotationPending, true);
  assert.equal(failed.session.refreshToken, 'synthetic-refresh');
  const callCount = calls.length;
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  assert.equal(calls.length, callCount);
});

test('snapshot reads preserve the library during a live token rotation', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const priorLibrary = {
    status: 'ready', lastSuccessAt: nowValue,
    payload: { games: [{ providerGameId: 'x'.repeat(43), name: 'Prior Game' }] },
  };
  const base = connectedState();
  const store = memoryStore({ ...base, library: priorLibrary,
    session: { ...base.session, accessExpiresAt: nowValue + 1_000 } });
  const adapter = createEpic({ store, now: () => nowValue, fetchImpl: queuedFetch([
    async () => { started.resolve(); await release.promise; return json({ ...session, access_token: 'rotated-access', refresh_token: 'rotated-refresh' }); },
    json(verify),
    new Error('library unavailable after rotation'),
  ]) });
  const reader = createEpic({ store, now: () => nowValue, fetchImpl: () => assert.fail('snapshot reads must not refresh tokens') });
  const refresh = adapter.refresh({ force: true });
  try {
    await started.promise;
    const snapshots = await reader.snapshots();
    assert.equal(snapshots.library.status, 'ready');
    assert.equal(snapshots.library.games[0].name, 'Prior Game');
  } finally {
    release.resolve();
    await refresh;
  }
  assert.equal((await reader.snapshots()).library.status, 'stale');
});

test('a transient library failure preserves the previous complete snapshot', async () => {
  let time = nowValue;
  const responses = [...authSequence(), json(libraryPage), json(catalogResponse), json(playtimeResponse)];
  const { adapter, store, identified } = await connect({ responses, now: () => time });
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await adapter.refresh();
  time += 16 * 60 * 1_000;
  responses.push(new Error('synthetic network secret'));

  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'stale' });
  const library = (await adapter.snapshots()).library;
  assert.equal(library.status, 'stale');
  assert.equal(library.stale, true);
  assert.equal(library.games[0].name, 'Fixture Base');
  assert.equal(JSON.stringify(await store.read()).includes('synthetic network secret'), false);
});

test('incomplete library pagination and catalog failures retain the prior snapshot', async () => {
  const prior = {
    status: 'ready', lastSuccessAt: nowValue, nextRefreshAt: nowValue + 1,
    payload: { coverage: { kind: 'owned-pc-base-games' }, totals: { gameCount: 1 }, games: [{ providerGameId: 'y'.repeat(43), name: 'Prior Game' }] },
  };
  const paged = createEpic({
    store: memoryStore(connectedState({ library: prior })), now: () => nowValue,
    fetchImpl: queuedFetch([
      json({ records: [baseItem], responseMetadata: { nextCursor: 'next-page' } }),
      new Error('pagination interrupted'),
    ]),
  });
  assert.deepEqual(await paged.refresh({ force: true }), { status: 'stale' });
  assert.equal((await paged.snapshots()).library.games[0].name, 'Prior Game');

  const catalogFailure = createEpic({
    store: memoryStore(connectedState({ library: prior })), now: () => nowValue,
    fetchImpl: queuedFetch([json(libraryPage), new Error('catalog interrupted')]),
  });
  assert.deepEqual(await catalogFailure.refresh({ force: true }), { status: 'stale' });
  assert.equal((await catalogFailure.snapshots()).library.games[0].name, 'Prior Game');
});

test('disconnect revokes remotely, retries transient failures and clears invalid sessions', async () => {
  const first = await connect();
  await first.adapter.confirm({ confirmationId: first.identified.confirmationId });
  const responses = [new Error('synthetic network secret')];
  const failing = createEpic({ store: first.store, fetchImpl: queuedFetch(responses), now: () => nowValue });
  await assert.rejects(failing.disconnect(), { code: 'network-error' });
  const retained = await first.store.read();
  assert.equal(retained.status, 'connected');
  assert.equal(retained.session.refreshToken, 'synthetic-refresh');

  responses.push(new Response(null, { status: 204 }));
  assert.deepEqual(await failing.disconnect(), { status: 'not-configured' });
  assert.deepEqual(await first.store.read(), {});

  const second = await connect();
  await second.adapter.confirm({ confirmationId: second.identified.confirmationId });
  const invalid = createEpic({ store: second.store, fetchImpl: queuedFetch([new Response(null, { status: 401 })]), now: () => nowValue });
  assert.deepEqual(await invalid.disconnect(), { status: 'not-configured' });
  assert.deepEqual(await second.store.read(), {});
});

test('disconnect renews an expired access token before revoking the session', async () => {
  const { adapter, store, identified } = await connect();
  await adapter.confirm({ confirmationId: identified.confirmationId });
  await store.locked(async (state, save) => {
    state.session.accessExpiresAt = nowValue + 1_000;
    await save(state);
  });
  const rotated = { ...session, access_token: 'rotated-access', refresh_token: 'rotated-refresh' };
  const revoking = createEpic({ store, now: () => nowValue, fetchImpl: queuedFetch([
    new Response(null, { status: 401 }),
    json(rotated),
    new Response(null, { status: 204 }),
  ]) });
  assert.deepEqual(await revoking.disconnect(), { status: 'not-configured' });
  assert.deepEqual(await store.read(), {});
});

test('confirmation rejects a pending session bound to a different stored account', async () => {
  const confirmationId = 'c'.repeat(32);
  const store = memoryStore({
    status: 'reconnect-required', accountId: otherAccountId, displayName: 'OtherOwner',
    pending: {
      confirmationId, expiresAt: nowValue + 60_000, accountId, displayName: 'OwnerPlayer',
      session: { accessToken: 'pending-access', refreshToken: 'pending-refresh', accountId, displayName: 'OwnerPlayer',
        accessExpiresAt: nowValue + 3_600_000, refreshExpiresAt: nowValue + 86_400_000 },
    },
  });
  const adapter = createEpic({ store, now: () => nowValue, fetchImpl: () => assert.fail('confirm must not call upstream') });
  await assert.rejects(adapter.confirm({ confirmationId }), { code: 'owner-account-mismatch' });
  assert.equal((await store.read()).pending, undefined);
});

test('identity and stored projections contain no email or token material', async () => {
  const { adapter, store, identified } = await connect();
  await adapter.confirm({ confirmationId: identified.confirmationId });
  assert.deepEqual(await adapter.identity(), { id: null, displayName: 'OwnerPlayer', avatarUrl: null });
  const stored = JSON.stringify(await store.read());
  assert.equal(stored.includes('owner@example.test'), false);
  assert.equal(stored.includes(code), false);
  assert.equal(stored.includes('"email"'), false);
  const snapshots = JSON.stringify(await adapter.snapshots());
  assert.equal(snapshots.includes('synthetic-access'), false);
  assert.equal(snapshots.includes('synthetic-refresh'), false);
  assert.equal(snapshots.includes(accountId), false);
  assert.equal(JSON.stringify(await adapter.identity()).includes(accountId), false);
});

test('a library spanning more than 200 catalog namespaces is published completely', async () => {
  const records = Array.from({ length: 260 }, (_, index) => ({
    namespace: `catalog-${index}`, catalogItemId: 'base', appName: `app-${index}`, sandboxType: 'PUBLIC',
  }));
  const authentication = authSequence();
  const adapter = createEpic({ store: memoryStore(), now: () => nowValue, fetchImpl: async address => {
    const url = new URL(address);
    if (url.pathname.startsWith('/account/')) return authentication.shift();
    if (url.pathname === '/library/api/public/items') return json({ records, responseMetadata: {} });
    if (url.pathname.startsWith('/catalog/')) {
      const namespace = url.pathname.split('/')[5];
      return json({ base: { title: namespace, categories: [{ path: 'games' }], keyImages: [] } });
    }
    return json(records.map(row => ({ accountId, artifactId: row.appName, totalTime: 0 })));
  } });
  const pending = await adapter.identify({ authorizationCode: code });
  await adapter.confirm(pending);
  assert.equal((await adapter.refresh()).status, 'ready');
  const library = (await adapter.snapshots()).library;
  assert.equal(new Set(library.games.map(game => game.providerGameId)).size, 260);
  assert.equal(library.totals.knownPlaytimeGameCount, 260);
  assert.equal(library.games.every(game => /^[a-f0-9]{64}$/.test(game.providerGameId)), true);
});

test('disconnect never retries an uncertain refresh after its durable replacement fails', async () => {
  const base = connectedState();
  const store = memoryStore({ ...base, session: { ...base.session, accessExpiresAt: nowValue - 1 } },
    state => state.session?.refreshToken === 'replacement-refresh');
  const calls = [];
  const adapter = createEpic({ store, now: () => nowValue, fetchImpl: queuedFetch([
    new Response(null, { status: 401 }),
    json({ ...session, access_token: 'replacement-access', refresh_token: 'replacement-refresh' }),
    new Response(null, { status: 401 }),
  ], calls) });
  await assert.rejects(adapter.disconnect(), /durable write failure/);
  assert.equal((await store.read()).rotationPending, true);
  await assert.rejects(adapter.disconnect(), { code: 'reconnect-required' });
  assert.equal(calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
});

test('transient verification failure after a durable renewal does not discard the connection', async () => {
  const base = connectedState();
  const store = memoryStore({ ...base, session: { ...base.session, accessExpiresAt: nowValue + 1_000 },
    library: { status: 'ready', lastSuccessAt: nowValue, payload: { games: [{ name: 'Prior Game' }] } },
  });
  const adapter = createEpic({ store, now: () => nowValue, fetchImpl: queuedFetch([
    json({ ...session, access_token: 'replacement-access', refresh_token: 'replacement-refresh' }),
    new Error('verification temporarily unavailable'),
  ]) });
  assert.equal((await adapter.refresh({ force: true })).status, 'stale');
  assert.equal((await store.read()).session.refreshToken, 'replacement-refresh');
  assert.equal((await adapter.snapshots()).library.games[0].name, 'Prior Game');
  assert.equal((await adapter.snapshots()).library.status, 'stale');
  assert.equal((await adapter.identity()).displayName, 'OwnerPlayer');
});
