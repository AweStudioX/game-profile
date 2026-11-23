import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile } from '../lib/profile.mjs';

const id = '76561198000000000';
const key = 'b'.repeat(32);
const password = 'synthetic-password-1234';
const env = { STEAM_ID: id, STEAM_WEB_API_KEY: key, PROFILE_PASSWORD: password };
const auth = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
const get = (handle, resource, headers) => handle(new Request(`https://example.test/api/profile?resource=${encodeURIComponent(resource)}`, { headers }));

test('clean deployment runs an anonymous demo with canonical cross-platform progress', async () => {
  const handle = createProfile({ env: {}, fetchImpl: () => assert.fail('demo must not contact Steam') });
  const library = await (await get(handle, 'library')).json();
  const game = library.games.find(game => game.id === 'steam-100');
  assert.equal(library.games.filter(item => item.name === game.name).length, 1);
  assert.deepEqual(game.editions[0].copies.map(copy => copy.observations[0].provider), ['steam', 'psn', 'nintendo']);
  const detail = await (await get(handle, `games/${game.id}`)).json();
  assert.deepEqual(detail.progress.sets.map(set => set.source), ['psn', 'steam']);
});

test('partial deployment identifies missing and malformed settings without exposing values', async () => {
  const handle = createProfile({
    env: { STEAM_ID: id, PROFILE_PASSWORD: 'secret with spaces' },
    fetchImpl: () => assert.fail('incomplete config must not contact Steam'),
  });
  assert.deepEqual(await (await get(handle, 'setup')).json(), {
    mode: 'incomplete',
    issues: { STEAM_WEB_API_KEY: 'missing', PROFILE_PASSWORD: 'invalid' },
  });
  assert.equal((await get(handle, 'library')).status, 503);
});

test('accepts a 14-character password with punctuation without weakening the login check', async () => {
  const value = 'Dev$pass42!Ab?';
  const handle = createProfile({ env: { ...env, PROFILE_PASSWORD: value } });
  const credentials = candidate => ({ Authorization: `Basic ${Buffer.from(`owner:${candidate}`).toString('base64')}` });
  assert.deepEqual(await (await get(handle, 'setup')).json(), { mode: 'private' });
  assert.equal((await get(handle, 'login', credentials(`${value}x`))).status, 401);
  assert.equal((await get(handle, 'login', credentials(value))).status, 303);
});

test('session lookup reports only verified owner access without challenging visitors', async () => {
  const handle = createProfile({ env, fetchImpl: () => assert.fail('session must not contact platforms') });
  for (const authorization of [undefined, 'Basic invalid', `Basic ${Buffer.from('owner:wrong').toString('base64')}`]) {
    const response = await get(handle, 'session', authorization ? { Authorization: authorization } : {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('www-authenticate'), false);
    assert.deepEqual(await response.json(), { authenticated: false });
  }
  const signedIn = await get(handle, 'session', { Authorization: auth });
  assert.match(signedIn.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await signedIn.json(), { authenticated: true });
  for (const config of [{}, { PROFILE_PASSWORD: password }]) {
    assert.deepEqual(await (await get(createProfile({ env: config }), 'session', { Authorization: auth })).json(), { authenticated: false });
  }
});

test('real profile is publicly readable while credentials and management stay protected', async () => {
  const calls = [];
  const handle = createProfile({ env, fetchImpl: async (url, options) => {
    const uri = new URL(url);
    calls.push(uri.pathname);
    assert.equal(uri.origin, 'https://api.steampowered.com');
    assert.equal(options.headers['x-webapi-key'], key);
    assert(!url.includes(key));
    if (uri.pathname.includes('GetOwnedGames')) {
      assert.equal(JSON.parse(uri.searchParams.get('input_json')).steamid, id);
      return Response.json({ response: { game_count: 1, games: [{ appid: 42, name: 'A unique owned title', playtime_forever: 25 }] } });
    }
    if (uri.pathname.includes('GetPlayerSummaries')) {
      return Response.json({ response: { players: [{ steamid: id, personastate: 1 }] } });
    }
    assert.fail(`unexpected upstream request: ${uri.pathname}`);
  } });
  assert.deepEqual(await (await get(handle, 'setup')).json(), { mode: 'private' });
  for (const resource of ['platforms', 'login', 'connect-login']) {
    const response = await get(handle, resource);
    assert.equal(response.status, 401);
    if (resource.endsWith('login')) assert.match(response.headers.get('www-authenticate'), /Basic/);
  }
  assert.equal(calls.length, 0);
  const login = await get(handle, 'login', { Authorization: auth });
  assert.equal(login.headers.get('location'), '/');
  const [library, detail] = await Promise.all(['library', 'games/steam-42'].map(resource => get(handle, resource)));
  assert.equal(library.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(calls.length, 1);
  assert.match(library.headers.get('cache-control'), /no-store/);
  const output = await library.text();
  assert.match(output, /A unique owned title/);
  for (const secret of [key, id, password]) assert(!output.includes(secret));
  const presence = await get(handle, 'now-playing');
  assert.equal(presence.status, 200);
  const activity = await presence.text();
  for (const secret of [key, id, password]) assert(!activity.includes(secret));
  const connectLogin = await get(handle, 'connect-login', { Authorization: auth });
  assert.equal(connectLogin.status, 303);
  assert.equal(connectLogin.headers.get('location'), '/connect.html');
  assert.equal((await get(handle, 'games/steam-991', { Authorization: auth })).status, 404);
});
