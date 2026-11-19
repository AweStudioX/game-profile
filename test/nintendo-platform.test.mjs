import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNintendo } from '../lib/providers/nintendo.mjs';

function createStore(initial = {}) {
  let value = structuredClone(initial);
  let queue = Promise.resolve();
  return {
    async read() { return structuredClone(value); },
    locked(callback) {
      const run = queue.then(async () => callback(structuredClone(value), async next => {
        value = structuredClone(next);
      }));
      queue = run.catch(() => {});
      return run;
    },
  };
}

function json(body, status = 200) {
  return Response.json(body, { status });
}

function authorizationCallback(url, code = 'synthetic-session-code') {
  const state = new URL(url).searchParams.get('state');
  return `npf5c38e31cd085304b://auth#session_token_code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

function successfulFetch(calls, histories = [{
  titleId: '0100ABC',
  titleName: 'Synthetic Adventure',
  platform: 'Nintendo Switch',
  totalPlayedMinutes: 75,
  firstPlayedAt: '2025-01-01T10:00:00',
  lastPlayedAt: '2025-02-01T10:00:00Z',
  imageUrl: 'https://images.example.test/game.jpg',
}]) {
  return async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(init.redirect, 'manual');
    assert(init.signal instanceof AbortSignal);
    if (url.endsWith('/api/session_token')) {
      assert.match(String(init.body), /session_token_code=synthetic-session-code/);
      return json({ session_token: 'durable-session-secret' });
    }
    if (url.endsWith('/api/token')) {
      assert.equal(JSON.parse(init.body).session_token, 'durable-session-secret');
      return json({ access_token: 'short-access-secret', id_token: 'short-id-secret' });
    }
    if (url.endsWith('/play_histories')) {
      assert.equal(init.headers.Authorization, 'Bearer short-access-secret');
      return json({ playHistories: histories });
    }
    assert.fail(`unexpected Nintendo endpoint: ${url}`);
  };
}

test('start persists a single expiring PKCE request without returning verifier material', async () => {
  const store = createStore();
  const adapter = createNintendo({ store, fetchImpl: () => assert.fail('start must not fetch'), now: () => 1_000 });

  const result = await adapter.start();
  assert.deepEqual(Object.keys(result), ['url']);
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://accounts.nintendo.com');
  assert.equal(url.pathname, '/connect/1.0.0/authorize');
  assert.equal(url.searchParams.get('session_token_code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('session_token_code_verifier'), false);

  const state = await store.read();
  assert.equal(state.pending.state, url.searchParams.get('state'));
  assert.equal(state.pending.expiresAt, 601_000);
  assert.equal(url.searchParams.get('session_token_code_challenge').includes(state.pending.verifier), false);
});

test('confirm consumes a challenge on mismatch and never fetches or permits replay', async () => {
  const store = createStore();
  let calls = 0;
  const adapter = createNintendo({ store, fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  const { url } = await adapter.start();

  await assert.rejects(adapter.confirm({
    callback: authorizationCallback(url).replace(/state=[^&]+/, 'state=wrong'),
  }), { code: 'state-mismatch', stage: 'nintendo' });
  await assert.rejects(adapter.confirm({ callback: authorizationCallback(url) }), {
    code: 'authorization-not-pending', stage: 'nintendo',
  });
  assert.equal(calls, 0);
  assert.equal((await store.read()).pending, undefined);
});

test('confirm rejects an expired challenge after consuming it', async () => {
  let clock = 2_000;
  const store = createStore();
  const adapter = createNintendo({ store, fetchImpl: () => assert.fail('expired confirm must not fetch'), now: () => clock });
  const { url } = await adapter.start();
  clock += 10 * 60 * 1000;

  await assert.rejects(adapter.confirm({ callback: authorizationCallback(url) }), {
    code: 'authorization-not-pending', stage: 'nintendo',
  });
  assert.equal((await store.read()).pending, undefined);
});

test('confirm creates the initial bounded play-history snapshot without presence or credential output', async () => {
  const calls = [];
  const store = createStore();
  const clock = Date.parse('2026-01-02T03:04:05Z');
  const histories = [
    { titleId: '0100ABC', titleName: 'Synthetic Adventure', platform: 'Nintendo Switch', totalPlayedMinutes: 0,
      firstPlayedAt: '2025-01-01T10:00:00', lastPlayedAt: 'bad', imageUrl: 'javascript:alert(1)' },
    { titleId: '0100ABC', titleName: 'Synthetic Adventure', platform: 'Nintendo Switch 2' },
  ];
  const adapter = createNintendo({ store, fetchImpl: successfulFetch(calls, histories), now: () => clock });
  const authorization = await adapter.start();

  assert.deepEqual(await adapter.confirm({ callback: authorizationCallback(authorization.url) }), { status: 'ready' });
  const snapshots = await adapter.snapshots();
  assert.deepEqual(Object.keys(snapshots), ['library']);
  assert.equal(snapshots.library.status, 'ready');
  assert.equal(snapshots.library.latest, '2026-01-02T03:04:05.000Z');
  assert.equal(snapshots.library.games.length, 2);
  assert.equal(snapshots.library.games[0].playtimeMinutes, 0);
  assert.equal(snapshots.library.games[0].lastPlayedAt, null);
  assert.equal(snapshots.library.games[0].imageUrl, null);
  assert.notEqual(snapshots.library.games[0].providerGameId, snapshots.library.games[1].providerGameId);
  assert.equal(calls.length, 3);

  const visible = JSON.stringify(snapshots);
  for (const secret of ['durable-session-secret', 'short-access-secret', 'short-id-secret', 'synthetic-session-code']) {
    assert.equal(visible.includes(secret), false);
  }
});

test('refresh is rate-limited unless forced and stores only the latest acquired account snapshot', async () => {
  let clock = Date.parse('2026-02-01T00:00:00Z');
  const calls = [];
  const store = createStore();
  const adapter = createNintendo({ store, fetchImpl: successfulFetch(calls), now: () => clock });
  const authorization = await adapter.start();
  await adapter.confirm({ callback: authorizationCallback(authorization.url) });
  calls.length = 0;

  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'ready' });
  assert.equal(calls.length, 2);
  clock += 60 * 60 * 1000;
  assert.deepEqual(await adapter.refresh(), { status: 'ready' });
  assert.equal(calls.length, 4);
});

test('transient refresh failure preserves visible history and marks it stale', async () => {
  let fail = false;
  const calls = [];
  const store = createStore();
  const base = successfulFetch(calls);
  const adapter = createNintendo({ store, fetchImpl: async (...args) => {
    if (fail) throw new TypeError('synthetic network failure containing no credential');
    return base(...args);
  } });
  const authorization = await adapter.start();
  await adapter.confirm({ callback: authorizationCallback(authorization.url) });
  const before = await adapter.snapshots();
  fail = true;

  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'stale' });
  const after = await adapter.snapshots();
  assert.equal(after.library.status, 'stale');
  assert.deepEqual(after.library.games, before.library.games);
  assert.equal(after.library.latest, before.library.latest);
});

test('credential rejection requests reconnect while preserving the old snapshot', async () => {
  let reject = false;
  const calls = [];
  const store = createStore();
  const base = successfulFetch(calls);
  const adapter = createNintendo({ store, fetchImpl: async (input, init) => {
    if (reject && String(input).endsWith('/api/token')) return json({ error: 'invalid_grant' }, 401);
    return base(input, init);
  } });
  const authorization = await adapter.start();
  await adapter.confirm({ callback: authorizationCallback(authorization.url) });
  reject = true;

  assert.deepEqual(await adapter.refresh({ force: true }), { status: 'reconnect-required' });
  const { library } = await adapter.snapshots();
  assert.equal(library.status, 'reconnect-required');
  assert.equal(library.games[0].name, 'Synthetic Adventure');
});

test('successful reconnect atomically replaces the prior account and does not retain its games', async () => {
  const calls = [];
  const store = createStore();
  let histories = [{ titleId: 'OLD', titleName: 'Old Account Game', platform: 'Nintendo Switch' }];
  const adapter = createNintendo({
    store,
    fetchImpl: (...args) => successfulFetch(calls, histories)(...args),
  });
  let authorization = await adapter.start();
  await adapter.confirm({ callback: authorizationCallback(authorization.url) });
  histories = [{ titleId: 'NEW', titleName: 'New Account Game', platform: 'Nintendo Switch 2' }];
  authorization = await adapter.start();

  assert.deepEqual(await adapter.confirm({ callback: authorizationCallback(authorization.url) }), { status: 'ready' });
  assert.deepEqual((await adapter.snapshots()).library.games.map(game => game.name), ['New Account Game']);
  assert.equal(JSON.stringify(await store.read()).includes('Old Account Game'), false);
});

test('failed reconnect consumes its challenge but keeps the working account and snapshot', async () => {
  const calls = [];
  const store = createStore();
  let rejectExchange = false;
  const base = successfulFetch(calls);
  const adapter = createNintendo({ store, fetchImpl: async (input, init) => {
    if (rejectExchange && String(input).endsWith('/api/session_token')) return json({ error: 'invalid_grant' }, 400);
    return base(input, init);
  } });
  let authorization = await adapter.start();
  await adapter.confirm({ callback: authorizationCallback(authorization.url) });
  const before = await adapter.snapshots();
  rejectExchange = true;
  authorization = await adapter.start();

  await assert.rejects(adapter.confirm({ callback: authorizationCallback(authorization.url) }), {
    code: 'reconnect-required', stage: 'nintendo',
  });
  assert.deepEqual(await adapter.snapshots(), before);
  assert.equal((await store.read()).pending, undefined);
});

test('disconnect atomically removes pending authorization, session, and history', async () => {
  const calls = [];
  const store = createStore();
  const adapter = createNintendo({ store, fetchImpl: successfulFetch(calls) });
  const authorization = await adapter.start();
  await adapter.confirm({ callback: authorizationCallback(authorization.url) });

  assert.deepEqual(await adapter.disconnect(), { status: 'not-configured' });
  assert.deepEqual(await store.read(), {});
  assert.deepEqual(await adapter.snapshots(), {
    library: { status: 'not-configured', latest: null, games: [] },
  });
});
