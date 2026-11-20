import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/dashboard/app.mjs', import.meta.url), 'utf8');
// Run the page renderer with a minimal DOM; no network or global browser state.
function renderer() {
  const element = (tag, text = '') => ({
    tag, textContent: text, children: [], dataset: {}, hidden: false,
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute() {},
    get childElementCount() { return this.children.length; },
  });
  const elements = { activity: element('div'), 'activity-status': element('span') };
  const context = vm.createContext({
    $: id => elements[id], node: element,
    platformTag: id => element('span', id),
    recordDate: value => value ? element('time', value) : null,
    sourceLabel: status => status,
  });
  const start = source.indexOf('function renderActivity(');
  const end = source.indexOf('\nfunction renderUnlockSet(', start);
  vm.runInContext(source.slice(start, end), context);
  return { elements, render: context.renderActivity };
}
const text = node => [node.textContent, ...node.children.map(text)].join(' ');

for (const state of ['offline', 'unknown']) {
  test(`activity remains visible for ${state} with source diagnostics`, () => {
    const { elements, render } = renderer();
    render({ state, sources: { psn: { status: 'unavailable', lastSuccessAt: '2026-01-01T00:00:00Z' } } });
    assert.equal(elements.activity.hidden, false);
    assert.match(elements['activity-status'].textContent, state === 'offline' ? /未检测到游玩/ : /状态未知/);
    assert.match(text(elements.activity), /psn.*2026-01-01T00:00:00Z.*unavailable/);
  });
}

test('playing displays game and returns to an explicit idle state', () => {
  const { elements, render } = renderer();
  render({ state: 'playing', sessions: [{ game: { name: 'Example Game' }, primarySource: 'steam' }] });
  assert.match(text(elements.activity), /Example Game.*steam/);
  render({ state: 'offline' });
  assert.doesNotMatch(text(elements.activity), /Example Game/);
  assert.match(text(elements.activity), /未报告正在游玩/);
});
