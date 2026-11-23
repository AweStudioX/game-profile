import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile } from '../lib/profile.mjs';
import { createSyncSettings } from '../lib/sync-settings.mjs';

const env = { STEAM_ID: '76561198000000000', STEAM_WEB_API_KEY: 'a'.repeat(32), PROFILE_PASSWORD: 'test-password-2026' };
const origin = 'https://profile.example';
const auth = { Authorization: `Basic ${Buffer.from(`owner:${env.PROFILE_PASSWORD}`).toString('base64')}` };
const request = (resource, options) => new Request(`${origin}/api/profile?resource=${resource}`, options);

test('platform actions require owner authentication and same-origin POST', async () => {
  let starts = 0;
  const handle = createProfile({ env, platforms: { nintendo: { start() { starts++; return { url: 'https://accounts.nintendo.com/' }; } } } });
  const action = (headers, body = { provider: 'nintendo', action: 'start' }) => handle(request('platform-action', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
  assert.equal((await action({ Origin: origin })).status, 401);
  assert.equal((await action({ ...auth, Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await handle(request('platform-action', { headers: auth }))).status, 405);
  assert.equal((await action({ ...auth, Origin: origin }, { provider: 'nintendo', action: 'constructor' })).status, 400);
  assert.deepEqual(await (await action({ ...auth, Origin: origin })).json(), { url: 'https://accounts.nintendo.com/' });
  assert.equal(starts, 1);
});

test('a Steam-only deployment cannot start a platform connection', async () => {
  const handle = createProfile({ env });
  const status = await handle(request('platforms', { headers: auth }));
  assert.deepEqual(await status.json(), {
    storage: 'not-configured', sources: {}, identities: {},
    identityVisibility: { steam: false, psn: false, nintendo: false, xbox: false, epic: false },
  });
  assert.equal((await handle(request('platform-action', {
    method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/json' },
    body: '{"provider":"psn","action":"identify"}',
  }))).status, 503);
});

test('identity disclosure defaults off and only owner changes survive a new handler', async () => {
  let state = {};
  const store = {
    read: async () => structuredClone(state),
    locked: action => action(structuredClone(state), async value => { state = structuredClone(value); }),
  };
  const identity = { id: '76561198000000000', displayName: 'Example Player', avatarUrl: null };
  const platforms = {
    steam: {
      snapshots: async () => ({ library: { status: 'ready', games: [] } }),
      identity: async () => ({ ...identity, apiKey: 'never-public' }),
    },
    psn: {
      snapshots: async () => ({ library: { status: 'connected' } }),
      identity: async () => ({ id: 'OtherPlayer', displayName: 'OtherPlayer', avatarUrl: null }),
    },
  };
  const make = () => createProfile({ env, platforms, syncSettings: createSyncSettings({ store }) });
  const visible = async handle => (await handle(request('identities'))).json();
  const change = (handle, visible, headers = auth, platform = 'steam') => handle(request('platform-action', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ provider: 'profile', action: 'visibility', platform, visible }),
  }));
  const handle = make();
  assert.deepEqual(await visible(handle), { identities: {} });
  assert.equal((await change(handle, true, {})).status, 401);
  assert.equal((await change(handle, true, { ...auth, Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await change(handle, 'true')).status, 422);
  assert.equal((await change(handle, true, auth, '__proto__')).status, 422);
  assert.deepEqual(await visible(handle), { identities: {} });
  const owner = await (await handle(request('platforms', { headers: auth }))).json();
  assert.deepEqual(owner.identities.steam, identity);
  assert.equal(owner.identityVisibility.steam, false);
  assert.equal((await change(handle, true)).status, 200);
  assert.deepEqual(await visible(make()), { identities: { steam: identity } });
  assert.equal((await change(make(), false)).status, 200);
  assert.deepEqual(await visible(make()), { identities: {} });
  const unavailable = createProfile({ env, platforms, syncSettings: { status() { throw new Error('offline'); } } });
  assert.deepEqual(await visible(unavailable), { identities: {} });
});
