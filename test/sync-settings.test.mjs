import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile } from '../lib/profile.mjs';
import { createSyncSettings } from '../lib/sync-settings.mjs';
import { createSteamConnection } from '../lib/steam-connection.mjs';

function memoryStore() {
  let state = {};
  return { read: async () => structuredClone(state), locked: action => action(structuredClone(state), async value => { state = structuredClone(value); }) };
}

test('daily runs only at the configured UTC hour; hourly persists across instances and deduplicates slots', async () => {
  const store = memoryStore();
  let now;
  const config = createSyncSettings({ store, now: () => now });
  const calls = [];
  const provider = name => ({ async refresh() { calls.push(name); if (name === 'psn') throw new Error('failed'); } });
  const providers = Object.fromEntries(['steam', 'psn', 'nintendo'].map(name => [name, provider(name)]));
  async function tick(hour, runner = config) {
    const slot = new Date(Date.UTC(2026, 10, 19, hour));
    now = +slot + 900_000;
    await runner.run(slot, providers);
  }
  assert.equal((await config.status()).cadence, 'daily');
  await tick(1);
  assert.deepEqual(calls, []);
  await tick(2);
  await tick(2);
  await tick(3);
  assert.deepEqual(calls, ['steam', 'psn', 'nintendo']);
  await config.configure({ cadence: 'hourly' });
  const restarted = createSyncSettings({ store, now: () => now });
  await tick(4, restarted);
  await tick(3, restarted);
  assert.deepEqual(calls, ['steam', 'psn', 'nintendo', 'steam', 'psn', 'nintendo']);
  assert.deepEqual(await restarted.status(), {
    cadence: 'hourly', lastScheduledAt: '2026-11-19T04:00:00.000Z',
    identityVisibility: { steam: false, psn: false, nintendo: false },
  });
});

test('owner can configure Steam with only a dashboard password and persisted storage', async () => {
  const origin = 'https://profile.example';
  const env = { PROFILE_PASSWORD: 'test-only-password' };
  const auth = { Authorization: `Basic ${Buffer.from(`owner:${env.PROFILE_PASSWORD}`).toString('base64')}` };
  const steamId = '76561198000000000';
  const apiKey = 'a'.repeat(32);
  const store = memoryStore();
  const fakeApi = (_url, { headers }) => headers['x-webapi-key'] === apiKey
    ? Response.json({ response: { game_count: 1, games: [{ appid: 101, name: 'Example Game', playtime_forever: 90 }] } })
    : new Response(null, { status: 403 });
  const make = () => createProfile({ env, fetchImpl: fakeApi, platforms: { steam: createSteamConnection({ store, fetchImpl: fakeApi }) } });
  const request = (resource, options = {}) => new Request(`${origin}/api/profile?resource=${resource}`, options);
  const configure = apiKey => make()(request('platform-action', {
    method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'steam', action: 'configure', steamId, apiKey }),
  }));
  assert.deepEqual(await (await make()(request('setup'))).json(), { mode: 'private' });
  assert.deepEqual(await (await configure(apiKey)).json(), { status: 'connected' });
  assert.equal((await configure('b'.repeat(32))).status, 422);
  const response = await make()(request('library', { headers: auth }));
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(body).games[0].name, 'Example Game');
  assert.ok(!body.includes(apiKey) && !body.includes(steamId));
});
