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

test('partial deployment fails closed without contacting Steam', async () => {
  const handle = createProfile({ env: { STEAM_WEB_API_KEY: key }, fetchImpl: () => assert.fail('incomplete config must not contact Steam') });
  assert.deepEqual(await (await get(handle, 'setup')).json(), { mode: 'incomplete' });
  assert.equal((await get(handle, 'library')).status, 503);
});

test('real profile is private and uses configured Steam credentials only server-side', async () => {
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
    assert.fail(`unexpected upstream request: ${uri.pathname}`);
  } });
  assert.deepEqual(await (await get(handle, 'setup')).json(), { mode: 'private' });
  for (const resource of ['library', 'now-playing', 'games/steam-42', 'login']) {
    assert.equal((await get(handle, resource)).status, 401);
  }
  assert.equal(calls.length, 0);
  const login = await get(handle, 'login', { Authorization: auth });
  assert.equal(login.headers.get('location'), '/');
  const [library, detail] = await Promise.all(['library', 'games/steam-42'].map(resource => get(handle, resource, { Authorization: auth })));
  assert.equal(library.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(calls.length, 1);
  assert.match(library.headers.get('cache-control'), /no-store/);
  const output = await library.text();
  assert.match(output, /A unique owned title/);
  for (const secret of [key, id, password]) assert(!output.includes(secret));
  assert.equal((await get(handle, 'games/steam-991', { Authorization: auth })).status, 404);
});
