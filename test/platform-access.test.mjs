import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile } from '../lib/profile.mjs';

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
  assert.deepEqual(await status.json(), { storage: 'not-configured', sources: {} });
  assert.equal((await handle(request('platform-action', {
    method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/json' },
    body: '{"provider":"psn","action":"identify"}',
  }))).status, 503);
});
