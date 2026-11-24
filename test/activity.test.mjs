import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/dashboard/app.mjs', import.meta.url), 'utf8');
// Run the page renderer with a minimal DOM; no network or global browser state.
function renderer() {
  const element = (tag, text = '') => ({
    tag, textContent: text, children: [], dataset: {}, hidden: false,
    style: { setProperty() {} },
    classList: { add() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute() {},
    get childElementCount() { return this.children.length; },
  });
  const elements = { identities: element('section'), 'identity-list': element('ul') };
  const context = vm.createContext({
    $: id => elements[id], node: element,
    platformTag: (id, text = id) => element('span', text),
    label: id => id,
    recordDate: value => value ? element('time', value) : null,
    sourceLabel: status => status,
    model: { providerCounts: { steam: 2 } }, number: new Intl.NumberFormat('zh-CN'),
  });
  const start = source.indexOf('let sourcePayload');
  const end = source.indexOf('\nfunction renderUnlockSet(', start);
  vm.runInContext(source.slice(start, end), context);
  context.identityAvatar = () => element('span');
  context.renderIdentities({ identities: { steam: { displayName: 'Player' } } });
  return { elements, context, render: context.renderActivity };
}
const text = node => [node.textContent, ...node.children.map(text)].join(' ');

for (const state of ['offline', 'unknown']) {
  test(`account remains without empty activity text for ${state}`, () => {
    const { elements, render } = renderer();
    render({ state });
    assert.equal(elements.identities.hidden, false);
    assert.match(text(elements['identity-list']), /Player/);
    assert.doesNotMatch(text(elements['identity-list']), /正在游玩|未检测/);
  });
}

test('playing displays beside its account and clears on idle', () => {
  const { elements, render } = renderer();
  render({ state: 'playing', sessions: [{ game: { name: 'Example Game' }, primarySource: 'steam' }] });
  assert.match(text(elements['identity-list']), /Player.*Example Game/);
  render({ state: 'offline' });
  assert.doesNotMatch(text(elements['identity-list']), /Example Game/);
});

test('unified rows hide unconnected platforms and retain connected errors', () => {
  const { elements, context } = renderer();
  context.renderSources({ steam: { status: 'ready', lastSuccessAt: '2026-01-01' }, psn: { status: 'unavailable' }, xbox: { status: 'disabled' }, epic: { status: 'not-configured' } });
  const list = elements['identity-list'];
  assert.equal(list.children.length, 2);
  assert.match(text(list), /Player.*2 个游戏.*2026-01-01.*unavailable/);
  assert.doesNotMatch(text(list), /ready|disabled|not-configured/);
  context.renderSources({ steam: { status: 'disabled' } });
  assert.equal(elements.identities.hidden, true);
});

test('source-first responses merge with hidden identity and playing state', () => {
  const { elements, context } = renderer();
  context.renderIdentities({});
  context.renderSources({ steam: { status: 'ready' } });
  context.renderActivity({ state: 'playing', sessions: [{ primarySource: 'steam', game: { name: 'Example Game' } }] });
  context.renderIdentities({ identities: { steam: { avatarUrl: 'https://example.com/avatar.png' } } });
  assert.equal(elements['identity-list'].children.length, 1);
  assert.match(text(elements['identity-list']), /Example Game.*2 个游戏/);
  assert.doesNotMatch(text(elements['identity-list']), /Player/);
});
