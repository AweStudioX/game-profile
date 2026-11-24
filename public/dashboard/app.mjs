import { filterGames, label, libraryModel } from './model.mjs';
import { mountParticleTitle, moveSegment } from './dissolve.mjs';

const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
const hours = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const recentDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });
const ready = new Set(['ready', 'stale']);
const statuses = {
  ready: '已同步', stale: '已过期', disabled: '未接入', 'not-configured': '未配置',
  unavailable: '不可用', private: '隐私受限', 'reconnect-required': '需要重连', partial: '部分可用',
};
const sourceLabel = status => statuses[status] ?? '状态未知';
const pageSize = 24;
let model;
let activeProvider = '';
let shown = pageSize;
let modalRequest;

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
mountParticleTitle($('title'));

function playtime(seconds) {
  if (!Number.isFinite(seconds)) return '时长未知';
  if (seconds === 0) return '0 小时';
  return seconds < 3600 ? `${Math.max(1, Math.round(seconds / 60))} 分钟` : `${hours.format(seconds / 3600)} 小时`;
}

async function data(path, signal) {
  const response = await fetch(`/api/profile?resource=${encodeURIComponent(path)}`, { signal, cache: 'no-store' });
  if (!response.ok && !(path === 'library' && response.status === 503)) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function imageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// Brand paths from Simple Icons (CC0); other adapters use the controller mark.
const brandPaths = {
  steam: 'M11.979 0A12 12 0 0 0 .022 11.037l6.432 2.658a3.39 3.39 0 0 1 2.1-.584l2.861-4.142A4.524 4.524 0 1 1 15.939 13.438h-.105l-4.076 2.911a3.39 3.39 0 0 1-6.717 1.159L.436 15.27A12 12 0 1 0 11.979 0ZM7.54 18.21l-1.473-.61a2.55 2.55 0 1 0 1.068-3.485l1.523.63a1.875 1.875 0 0 1-1.118 3.465Zm11.415-9.303a3.015 3.015 0 1 1-6.03 0 3.015 3.015 0 0 1 6.03 0Zm-5.273-.005a2.265 2.265 0 1 0 4.53 0 2.265 2.265 0 0 0-4.53 0Z',
  psn: 'M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z',
  nintendo: 'M14.176 24h3.674c3.376 0 6.15-2.774 6.15-6.15V6.15C24 2.775 21.226 0 17.85 0H14.1c-.074 0-.15.074-.15.15v23.7c-.001.076.075.15.226.15zm4.574-13.199c1.351 0 2.399 1.125 2.399 2.398 0 1.352-1.125 2.4-2.399 2.4-1.35 0-2.4-1.049-2.4-2.4-.075-1.349 1.05-2.398 2.4-2.398zM11.4 0H6.15C2.775 0 0 2.775 0 6.15v11.7C0 21.226 2.775 24 6.15 24h5.25c.074 0 .15-.074.15-.149V.15c.001-.076-.075-.15-.15-.15zM9.676 22.051H6.15c-2.326 0-4.201-1.875-4.201-4.201V6.15c0-2.326 1.875-4.201 4.201-4.201H9.6l.076 20.102zM3.75 7.199c0 1.275.975 2.25 2.25 2.25s2.25-.975 2.25-2.25c0-1.273-.975-2.25-2.25-2.25s-2.25.977-2.25 2.25z',
  xbox: 'M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z',
  epic: 'M3.537 0C2.165 0 1.66.506 1.66 1.879V18.44a4.262 4.262 0 00.02.433c.031.3.037.59.316.92.027.033.311.245.311.245.153.075.258.13.43.2l8.335 3.491c.433.199.614.276.928.27h.002c.314.006.495-.071.928-.27l8.335-3.492c.172-.07.277-.124.43-.2 0 0 .284-.211.311-.243.28-.33.285-.621.316-.92a4.261 4.261 0 00.02-.434V1.879c0-1.373-.506-1.88-1.878-1.88zm13.366 3.11h.68c1.138 0 1.688.553 1.688 1.696v1.88h-1.374v-1.8c0-.369-.17-.54-.523-.54h-.235c-.367 0-.537.17-.537.539v5.81c0 .369.17.54.537.54h.262c.353 0 .523-.171.523-.54V8.619h1.373v2.143c0 1.144-.562 1.71-1.7 1.71h-.694c-1.138 0-1.7-.566-1.7-1.71V4.82c0-1.144.562-1.709 1.7-1.709zm-12.186.08h3.114v1.274H6.117v2.603h1.648v1.275H6.117v2.774h1.74v1.275h-3.14zm3.816 0h2.198c1.138 0 1.7.564 1.7 1.708v2.445c0 1.144-.562 1.71-1.7 1.71h-.799v3.338h-1.4zm4.53 0h1.4v9.201h-1.4zm-3.13 1.235v3.392h.575c.354 0 .523-.171.523-.54V4.965c0-.368-.17-.54-.523-.54zm-3.74 10.147a1.708 1.708 0 01.591.108 1.745 1.745 0 01.49.299l-.452.546a1.247 1.247 0 00-.308-.195.91.91 0 00-.363-.068.658.658 0 00-.28.06.703.703 0 00-.224.163.783.783 0 00-.151.243.799.799 0 00-.056.299v.008a.852.852 0 00.056.31.7.7 0 00.157.245.736.736 0 00.238.16.774.774 0 00.303.058.79.79 0 00.445-.116v-.339h-.548v-.565H7.37v1.255a2.019 2.019 0 01-.524.307 1.789 1.789 0 01-.683.123 1.642 1.642 0 01-.602-.107 1.46 1.46 0 01-.478-.3 1.371 1.371 0 01-.318-.455 1.438 1.438 0 01-.115-.58v-.008a1.426 1.426 0 01.113-.57 1.449 1.449 0 01.312-.46 1.418 1.418 0 01.474-.309 1.58 1.58 0 01.598-.111 1.708 1.708 0 01.045 0zm11.963.008a2.006 2.006 0 01.612.094 1.61 1.61 0 01.507.277l-.386.546a1.562 1.562 0 00-.39-.205 1.178 1.178 0 00-.388-.07.347.347 0 00-.208.052.154.154 0 00-.07.127v.008a.158.158 0 00.022.084.198.198 0 00.076.066.831.831 0 00.147.06c.062.02.14.04.236.061a3.389 3.389 0 01.43.122 1.292 1.292 0 01.328.17.678.678 0 01.207.24.739.739 0 01.071.337v.008a.865.865 0 01-.081.382.82.82 0 01-.229.285 1.032 1.032 0 01-.353.18 1.606 1.606 0 01-.46.061 2.16 2.16 0 01-.71-.116 1.718 1.718 0 01-.593-.346l.43-.514c.277.223.578.335.9.335a.457.457 0 00.236-.05.157.157 0 00.082-.142v-.008a.15.15 0 00-.02-.077.204.204 0 00-.073-.066.753.753 0 00-.143-.062 2.45 2.45 0 00-.233-.062 5.036 5.036 0 01-.413-.113 1.26 1.26 0 01-.331-.16.72.72 0 01-.222-.243.73.73 0 01-.082-.36v-.008a.863.863 0 01.074-.359.794.794 0 01.214-.283 1.007 1.007 0 01.34-.185 1.423 1.423 0 01.448-.066 2.006 2.006 0 01.025 0zm-9.358.025h.742l1.183 2.81h-.825l-.203-.499H8.623l-.198.498h-.81zm2.197.02h.814l.663 1.08.663-1.08h.814v2.79h-.766v-1.602l-.711 1.091h-.016l-.707-1.083v1.593h-.754zm3.469 0h2.235v.658h-1.473v.422h1.334v.61h-1.334v.442h1.493v.658h-2.255zm-5.3.897l-.315.793h.624zm-1.145 5.19h8.014l-4.09 1.348z',
};

function platformTag(id, text = label(id)) {
  const tag = node('span', undefined, 'platform-tag');
  const brand = /^ps[345]$/.test(id) ? 'psn' : /^(nintendo|switch)/i.test(id) ? 'nintendo' : /^xbox/.test(id) ? 'xbox' : id;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (Object.hasOwn(brandPaths, brand)) {
    path.setAttribute('d', brandPaths[brand]);
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('d', 'M7 7h10a4 4 0 0 1 4 3.5l1 5a2.5 2.5 0 0 1-4.3 2.2L15 15H9l-2.7 2.7A2.5 2.5 0 0 1 2 15.5l1-5A4 4 0 0 1 7 7Zm0 2v4m-2-2h4m6 0h.01m3 1h.01');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
  }
  svg.append(path);
  tag.append(svg, text);
  return tag;
}

function recordDate(value, prefix) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const time = node('time', `${prefix} ${date.format(timestamp)}`);
  time.dateTime = new Date(timestamp).toISOString();
  return time;
}

const grades = { bronze: '铜杯', silver: '银杯', gold: '金杯', platinum: '白金杯' };
const percent = value => `${hours.format(value)}%`;

function unlockRow(unlock) {
  const state = unlock.unlocked === true ? '已解锁' : unlock.unlocked === false ? '未解锁' : '状态未知';
  const row = node('li', undefined, 'unlock');
  const thumbnail = node('span', undefined, 'unlock-icon');
  thumbnail.setAttribute('aria-hidden', 'true');
  const symbol = platformTag(unlock.source, '');
  thumbnail.append(symbol);
  const url = imageUrl(unlock.imageUrl);
  if (url) {
    const image = node('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = url;
    thumbnail.append(image);
  }
  const body = node('div', undefined, 'unlock-body');
  const title = node('div', undefined, 'unlock-title');
  title.append(node('strong', unlock.name), node('span', state, 'badge'));
  if (unlock.unlocked === true) title.lastChild.dataset.tone = 'active';
  body.append(title);
  if (unlock.description) body.append(node('p', unlock.description, 'muted'));
  const metadata = node('div', undefined, 'record-meta');
  if (Object.hasOwn(grades, unlock.grade)) metadata.append(node('span', grades[unlock.grade]));
  if (Number.isFinite(unlock.gamerscore)) metadata.append(node('span', `${number.format(unlock.gamerscore)} G`));
  const earnedAt = recordDate(unlock.unlockedAt, '解锁于');
  if (earnedAt) metadata.append(earnedAt);
  if (Number.isFinite(unlock.rarityPercent)) metadata.append(node('span', `全球解锁率 ${percent(unlock.rarityPercent)}`));
  if (metadata.childElementCount) body.append(metadata);
  row.append(thumbnail, body);
  return row;
}

let sourcePayload = {};

function renderSources(sources) {
  sourcePayload = sources;
  renderIdentities(identityPayload);
}

let identityPayload = {};
let activityPayload = {};

function renderActivity(payload) {
  activityPayload = payload;
  renderIdentities(identityPayload);
}

function identityAvatar(provider, value) {
  const avatar = node('span', undefined, 'identity-avatar');
  avatar.setAttribute('role', 'img');
  avatar.setAttribute('aria-label', `${label(provider)} 账号头像`);
  avatar.setAttribute('title', `${label(provider)} 账号头像`);
  const fallback = node('span', undefined, 'avatar-placeholder');
  fallback.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/></svg>';
  avatar.append(fallback);
  const url = imageUrl(value);
  if (!url) return avatar;
  const image = node('img');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => { avatar.dataset.hasImage = 'true'; }, { once: true });
  image.addEventListener('error', () => {
    delete avatar.dataset.hasImage;
    image.remove();
  }, { once: true });
  image.src = url;
  avatar.append(image);
  return avatar;
}

function renderIdentities(payload) {
  identityPayload = payload;
  const sessions = activityPayload.state === 'playing' && Array.isArray(activityPayload.sessions) ? activityPayload.sessions : [];
  const ids = new Set([...Object.keys(payload?.identities ?? {}), ...Object.keys(sourcePayload), ...sessions.map(session => session.primarySource || session.platform).filter(Boolean)]);
  for (const id of ids) {
    if (['disabled', 'not-configured'].includes(sourcePayload[id]?.status)) ids.delete(id);
  }
  $('identity-list').replaceChildren(...Array.from(ids, (id, index) => {
    const identity = payload?.identities?.[id] ?? {};
    const item = node('li', undefined, 'identity');
    item.dataset.platform = id;
    item.style.setProperty('--i', String(index));
    const backdrop = platformTag(id, '');
    backdrop.classList.add('identity-backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    item.append(backdrop);
    item.append(identityAvatar(id, identity.avatarUrl));
    const copy = node('span', undefined, 'identity-copy');
    const name = identity.displayName || identity.id;
    if (name) copy.append(node('strong', name, 'identity-name'));
    for (const session of sessions.filter(session => (session.primarySource || session.platform) === id)) {
      const status = node('span', undefined, 'identity-activity');
      status.append(node('span', '正在游玩', 'catalog-live'), node('strong', session.game?.name ?? '未命名游戏'));
      copy.append(status);
    }
    item.append(copy);
    const sync = node('span', undefined, 'identity-sync');
    const source = sourcePayload[id];
    const count = model?.providerCounts[id];
    if (count !== undefined) {
      const total = node('span', `${number.format(count)} 个游戏`, 'identity-count');
      total.title = '该平台游戏数，跨平台游戏可重复';
      sync.append(total);
    }
    if (source && source.status !== 'ready') sync.append(node('span', sourceLabel(source.status), 'identity-sync-error'));
    const updated = recordDate(source?.lastSuccessAt, '同步于');
    if (updated) sync.append(updated);
    item.append(sync);
    return item;
  }));
  $('identities').hidden = ids.size === 0;
}

function renderUnlockSet(set, game, showSetName) {
  const panel = node('div', undefined, 'unlock-set');
  const summary = node('div', undefined, 'unlock-summary');
  const edition = game.editions.find(item => item.id === set.editionId);
  const platform = set.platform?.toLowerCase();
  const context = [
    showSetName ? set.name : null,
    edition?.id !== 'standard' ? edition?.name : null,
    platform && platform !== 'unknown' ? label(platform) : null,
  ].filter(Boolean);
  if (context.length) summary.append(node('span', context.join(' · '), 'muted'));
  const { earned, available, known, completionPercent } = set.summary ?? {};
  if (Number.isFinite(earned) && Number.isFinite(available) && known > 0) {
    summary.append(node('span', `${number.format(earned)} / ${number.format(available)}${known < available ? ' · 部分' : ''}`, 'unlock-count'));
  }
  panel.append(summary);
  if (Number.isFinite(completionPercent)) {
    const meter = node('progress');
    meter.max = 100;
    meter.value = completionPercent;
    meter.setAttribute('aria-label', `完成率 ${percent(completionPercent)}`);
    panel.append(meter);
  }
  const unlocks = [...(set.unlocks ?? [])].sort((a, b) =>
    Number(b.unlocked === true) - Number(a.unlocked === true)
    || (b.unlockedAt ?? '').localeCompare(a.unlockedAt ?? ''));
  if (!unlocks.length) {
    panel.append(node('p', '没有可显示的成就记录。', 'muted'));
    return panel;
  }
  const list = node('ul', undefined, 'unlock-list');
  list.append(...unlocks.map(unlockRow));
  panel.append(list);
  return panel;
}

function renderProgress(progress, game) {
  const heading = node('h3', '成就与奖杯');
  const groups = new Map(game.providers.map(provider => [provider, []]));
  for (const set of progress?.sets ?? []) {
    if (!groups.has(set.source)) groups.set(set.source, []);
    groups.get(set.source).push(set);
  }
  if (!groups.size) return [heading, node('p', '暂无可用成就数据。', 'muted')];

  const renderProvider = (provider, sets) => {
    if (sets.length) return sets.map(set => renderUnlockSet(set, game, sets.length > 1));
    if (provider === 'epic') return [node('p', 'Epic 当前同步游戏库和游玩时长，不包含成就。', 'muted')];
    const sources = (progress?.sources ?? []).filter(item => item.source === provider);
    const text = sources.some(item => item.status === 'pending') ? '尚未同步。'
      : sources.some(item => item.status === 'private') ? '此平台的成就记录未公开。'
        : sources.length && sources.every(item => item.status === 'unsupported') ? '此平台没有可同步的成就记录。'
          : '此平台的成就记录暂不可用。';
    return [node('p', text, 'muted')];
  };
  const entries = [...groups];
  if (entries.length === 1) {
    const [[provider, sets]] = entries;
    heading.replaceChildren(platformTag(provider, `${label(provider)} ${provider === 'psn' ? '奖杯' : '成就'}`));
    return [heading, ...renderProvider(provider, sets)];
  }

  const switcher = node('div', undefined, 'unlock-switcher');
  switcher.setAttribute('role', 'tablist');
  switcher.setAttribute('aria-label', '成就平台');
  const panels = entries.map((_, index) => {
    const panel = node('section', undefined, 'unlock-source');
    panel.id = `unlock-platform-${index}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `unlock-tab-${index}`);
    panel.tabIndex = 0;
    return panel;
  });
  const tabs = entries.map(([provider], index) => {
    const button = node('button', undefined, 'unlock-tab');
    button.type = 'button';
    button.id = `unlock-tab-${index}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panels[index].id);
    button.append(platformTag(provider));
    button.addEventListener('click', () => selectPlatform(index));
    return button;
  });

  let current = -1;
  function selectPlatform(next) {
    if (next === current) return;
    const section = switcher.closest('.progress-section');
    const before = section?.offsetHeight;
    current = next;
    for (const [index, tab] of tabs.entries()) {
      const selected = index === next;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[index].hidden = !selected;
    }
    if (!panels[next].hasChildNodes()) panels[next].append(...renderProvider(...entries[next]));
    if (section) settleHeight(section, before);
  }
  switcher.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectPlatform(next);
    tabs[next].focus();
  });
  switcher.append(...tabs);
  selectPlatform(Math.max(0, entries.findIndex(([, sets]) => sets.length)));
  return [heading, switcher, ...panels];
}

function settleHeight(section, before) {
  if (document.documentElement.dataset.theme !== 'classic' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const animation of section.getAnimations()) animation.cancel();
  const after = section.offsetHeight;
  if (before !== after) section.animate([
    {height:`${before}px`, overflow:'clip'}, {height:`${after}px`, overflow:'clip'},
  ], {duration:210, easing:'cubic-bezier(.2,.75,.25,1)'});
}

function flipToDetail(cover, start, signal) {
  const dialog = $('detail');
  const end = dialog.getBoundingClientRect();
  const dx = start.x + start.width / 2 - end.x - end.width / 2;
  const dy = start.y + start.height / 2 - end.y - end.height / 2;
  const hinge = `translate(${dx * .28}px, ${dy * .28 - 16}px) perspective(1100px)`;
  const front = cover.cloneNode(true);
  front.setAttribute('aria-hidden', 'true');
  front.setAttribute('popover', 'manual');
  front.classList.add('flight-cover');
  Object.assign(front.style, {left:`${start.x}px`, top:`${start.y}px`, width:`${start.width}px`, height:`${start.height}px`});
  dialog.append(front);
  front.showPopover();
  cover.style.visibility = 'hidden';
  const lift = front.animate([
    {transform:'translate(0,0) perspective(1100px) rotateY(0deg) scale(1)', filter:'brightness(1)'},
    {transform:`translate(${-dx * .23}px, ${-dy * .23 - 14}px) perspective(1100px) rotateY(18deg) scale(1.08)`, filter:'brightness(1)', offset:.36},
    {transform:`translate(${-dx * .72}px, ${-dy * .72 - 16}px) perspective(1100px) rotateY(90deg) scale(1.2)`, filter:'brightness(.80)'}
  ], {duration:210, easing:'cubic-bezier(.38,0,.58,1)', fill:'forwards'});
  const unfold = dialog.animate([
    {transform:`${hinge} rotateY(-90deg) scale(${start.width * 1.2 / end.width},${start.height * 1.2 / end.height})`, filter:'brightness(.80)'},
    {transform:'translate(0,0) perspective(1100px) rotateY(0deg) scale(1,1)', filter:'brightness(1)'}
  ], {delay:210, duration:235, easing:'cubic-bezier(.3,.45,.22,1)', fill:'backwards'});
  // Reveal ink only after its surface is wide enough to read.
  const ink = [dialog.querySelector('.dialog-header'), $('detail-body')].map((part, i) =>
    part.animate([{opacity:0}, {opacity:1}], {
      delay:248 + i * 28, duration:145, easing:'ease-out', fill:'backwards'
    }));
  function clear() {
    for (const animation of ink) animation.cancel();
    lift.cancel(); unfold.cancel(); front.remove(); cover.style.removeProperty('visibility');
    signal.removeEventListener('abort', clear);
  }
  signal.addEventListener('abort', clear, {once:true});
  return unfold.finished.then(clear, clear);
}

async function showGame(game, cover) {
  modalRequest?.abort();
  const request = modalRequest = new AbortController();
  $('detail-title').textContent = game.name;
  const copies = node('ul', undefined, 'record-list');
  for (const copy of game.copies) {
    const row = node('li');
    const title = node('div', undefined, 'record-meta');
    const providers = new Set(copy.observations?.map(item => item.provider).filter(Boolean));
    title.append(...[...providers].map(id => platformTag(id)));
    if (copy.platform && copy.platform !== 'unknown') title.append(node('span', label(copy.platform)));
    if (copy.edition && copy.edition !== 'Standard') title.append(node('span', copy.edition));
    title.append(node('strong', playtime(copy.playtime?.seconds)));
    row.append(title);
    const metadata = node('div', undefined, 'record-meta muted');
    const observation = copy.observations?.find(item => item.provider === copy.playtime?.selectedFrom)?.data
      ?? (copy.observations?.length === 1 ? copy.observations[0].data : null);
    const first = recordDate(observation?.firstPlayedAt, '首次游玩');
    const last = recordDate(observation?.lastPlayedAt, '最近游玩');
    if (first) metadata.append(first);
    if (last) metadata.append(last);
    if (Number.isSafeInteger(observation?.playCount)) metadata.append(node('span', `游玩 ${number.format(observation.playCount)} 次`));
    if (metadata.childElementCount) row.append(metadata);
    copies.append(row);
  }
  const progress = node('section', undefined, 'progress-section');
  progress.append(node('p', '正在读取成就…', 'muted loading-lines'));
  $('detail-body').replaceChildren(node('p', `累计 ${playtime(game.seconds)}`), copies, progress);
  const flip = document.documentElement.dataset.theme === 'classic' && !matchMedia('(prefers-reduced-motion: reduce)').matches && 'showPopover' in HTMLElement.prototype;
  const start = flip && cover.getBoundingClientRect();
  if (!$('detail').open) $('detail').showModal();
  const flight = start && flipToDetail(cover, start, request.signal);
  function finishProgress(children) {
    if (request.signal.aborted) return;
    const before = progress.offsetHeight;
    progress.replaceChildren(...children);
    progress.dataset.ready = '';
    settleHeight(progress, before);
  }
  try {
    const result = await data(`games/${encodeURIComponent(game.id)}`, request.signal);
    await flight;
    if (!request.signal.aborted) finishProgress(renderProgress(result.progress, game));
  } catch {
    await flight;
    finishProgress([node('p', '成就详情暂不可用。', 'muted')]);
  }
}

function gameCard(game, index) {
  const row = node('li');
  const button = node('button', undefined, 'game');
  button.type = 'button';
  const cover = node('span', 'NO COVER', 'cover');
  cover.setAttribute('aria-hidden', 'true');
  const portrait = imageUrl(game.artwork?.portraitUrl);
  const url = portrait || imageUrl(game.artwork?.landscapeUrl) || imageUrl(game.artwork?.squareUrl);
  if (url) {
    const image = node('img', undefined, portrait ? '' : 'wide');
    image.alt = '';
    image.loading = index < 6 ? 'eager' : 'lazy';
    image.decoding = 'async';
    cover.classList.add('art-pending');
    image.addEventListener('load', () => {
      cover.classList.remove('art-pending');
      if (cover.dataset.reveal !== undefined) revealCover(cover, index);
    }, { once: true });
    image.addEventListener('error', () => {
      image.remove();
      cover.classList.remove('art-pending');
    }, { once: true });
    image.src = url;
    cover.append(image);
  }
  const body = node('span', undefined, 'game-body');
  body.append(node('strong', game.name, 'game-name'));
  const meta = node('span', undefined, 'game-caption');
  if (game.providers.length) {
    const platforms = node('span', undefined, 'game-provider record-meta');
    platforms.append(...game.providers.map(id => {
      const tag = platformTag(id);
      tag.lastChild.replaceWith(node('span', label(id), 'game-platform-name'));
      tag.title = label(id);
      return tag;
    }));
    meta.append(platforms);
  }
  const duration = node('span', playtime(game.seconds), 'game-meta');
  if (game.platforms.length) duration.append(node('span', ` · ${game.platforms.map(label).join(' · ')}`, 'game-devices'));
  meta.append(duration);
  if (game.lastPlayed !== null) {
    const time = node('time', undefined, 'game-meta');
    time.dateTime = new Date(game.lastPlayed).toISOString();
    time.append(node('span', date.format(game.lastPlayed), 'game-date-full'), node('span', recentDate.format(game.lastPlayed), 'game-date-short'));
    meta.append(time);
  }
  body.append(meta);
  button.append(cover, body);
  button.addEventListener('click', () => showGame(game, cover));
  row.append(button);
  return row;
}

function renderFilters() {
  const buttons = [['', null], ...Object.entries(model.providerCounts).sort(([a], [b]) => label(a).localeCompare(label(b)))];
  $('filters').replaceChildren(...buttons.map(([id, count]) => {
    const button = node('button');
    button.append(id ? platformTag(id) : '全部');
    if (count !== null) button.append(node('span', ` ${number.format(count)}`, 'filter-count'));
    if (id === activeProvider) {
      const indicator = node('span', undefined, 'filter-indicator');
      indicator.setAttribute('aria-hidden', 'true');
      button.append(indicator);
    }
    button.type = 'button';
    button.dataset.provider = id;
    button.setAttribute('aria-pressed', String(id === activeProvider));
    return button;
  }));
}

function renderLibrary(append = false) {
  const sort = $('sort').value;
  const search = $('search').value;
  const matches = filterGames(model.games, { provider: activeProvider, search, sort });
  const grid = $('games');
  grid.dataset.sort = sort;
  const start = append ? grid.childElementCount : 0;
  const cards = matches.slice(start, shown).map((game, index) => gameCard(game, start + index));
  if (append) grid.append(...cards); else grid.replaceChildren(...cards);
  const results = $('results');
  results.dataset.refined = String(Boolean(activeProvider || search.trim()));
  results.textContent = `${number.format(matches.length)} 款游戏`;
  $('library-status').textContent = matches.length ? '' : model.games.length ? '没有符合筛选条件的游戏。' : '游戏库没有游戏。';
  $('more').hidden = matches.length <= shown;
  if (append) cards[0]?.firstElementChild.focus();
}

function ticker(formatted) {
  const value = node('span', formatted, 'ticker');
  if (document.documentElement.dataset.theme !== 'classic' || matchMedia('(prefers-reduced-motion: reduce)').matches) return value;
  const roll = node('span', undefined, 'ticker-roll');
  roll.setAttribute('aria-hidden', 'true');
  for (const [index, char] of Array.from(formatted).entries()) {
    if (!/[0-9]/.test(char)) { roll.append(char); continue; }
    const slot = node('span', undefined, 'ticker-window');
    const strip = node('span', '0123456789'.slice(0, Number(char) + 1).split('').join('\n'), 'ticker-strip');
    strip.style.setProperty('--delay', `${(formatted.length - index - 1) * 20}ms`);
    if (index === 0) strip.addEventListener('animationend', () => roll.remove(), { once: true });
    slot.append(strip);
    roll.append(slot);
  }
  value.append(roll);
  return value;
}

function librarySkeleton() {
  const list = node('ul', undefined, 'games skeleton-grid');
  list.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 6; i++) {
    const item = node('li');
    item.style.setProperty('--wave-offset', `${-90 * i}ms`);
    item.append(node('span', undefined, 'cover'), node('span', undefined, 'loading-lines'));
    list.append(item);
  }
  $('games').before(list);
  return list;
}

// Each cover uses a small transparent overlay; artwork never enters the canvas.
function revealCover(cover, index) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const classic = () => document.documentElement.dataset.theme === 'classic';
  if (!classic() || reduced.matches) return;
    const bounds = cover.getBoundingClientRect();
    if (!bounds.width || bounds.top >= innerHeight || bounds.bottom <= 0) return;
    const layer = node('canvas', undefined, 'grain-cover');
    const width = layer.width = Math.min(64, Math.ceil(bounds.width / 4));
    const height = layer.height = Math.round(width * bounds.height / bounds.width);
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    cover.append(layer);
    ctx.fillStyle = getComputedStyle(layer).color;
    ctx.fillRect(0, 0, width, height);

    // Bucket once in diagonal reading order with a ragged edge. Erase each grain once.
    const steps = Array.from({length: 32}, () => []);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const phase = .45 * x / width + .25 * y / height + .3 * Math.random();
        steps[Math.floor(phase * steps.length)].push(y * width + x);
      }
    }
    const start = performance.now() + index * 55;
    let next = 0;
    function frame(now) {
      if (!layer.isConnected || reduced.matches || !classic()) { layer.remove(); return; }
      const end = Math.min(steps.length, Math.floor((now - start) / 420 * steps.length));
      while (next < end) {
        for (const cell of steps[next++]) ctx.clearRect(cell % width, Math.floor(cell / width), 1, 1);
      }
      if (next < steps.length) requestAnimationFrame(frame);
      else layer.remove();
    }
    requestAnimationFrame(frame);
}

function showLibrary(payload) {
  model = libraryModel(payload);
  renderSources(model.sources);
  if (!Array.isArray(payload.games) || payload.status === 'unavailable') {
    const hasConnection = Object.values(model.sources).some(source => !['disabled', 'not-configured'].includes(source.status));
    $('library-status').textContent = hasConnection ? '游戏库暂不可用。' : '还没有连接游戏账号。';
    return;
  }
  if (model.knownSeconds !== null) $('hours').replaceChildren(ticker(hours.format(model.knownSeconds / 3600)), node('small', model.incomplete ? ' 小时 · 部分' : ' 小时'));
  $('game-count').replaceChildren(ticker(number.format(model.games.length)));
  $('played-count').textContent = number.format(model.games.filter(game => game.seconds > 0).length);
  $('source-count').textContent = number.format(Object.values(model.sources).filter(source => ready.has(source?.status)).length);
  $('hours').closest('dl').hidden = false;
  $('toolbar').hidden = false;
  renderFilters();
  renderLibrary();
}

function enableSegmentDrag(track, selector) {
  let pointer = null, dragged = false;
  track.addEventListener('pointerdown', event => {
    dragged = false;
    pointer = event.isPrimary && event.button === 0 && document.documentElement.dataset.theme === 'classic'
      ? {id:event.pointerId,x:event.clientX,y:event.clientY} : null;
  });
  track.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!dragged) {
      const dx = Math.abs(event.clientX-pointer.x), dy = Math.abs(event.clientY-pointer.y);
      if (dy > 12 && dy > dx) { pointer = null; return; }
      if (dx < 6) return;
      dragged = true;
      track.setPointerCapture(event.pointerId);
    }
    const item = document.elementFromPoint(event.clientX,event.clientY)?.closest(selector);
    if (!item || !track.contains(item) || item.matches('[aria-pressed="true"],:has(input:checked)')) return;
    const control = item.querySelector('input') ?? item;
    control.click();
    control.focus({preventScroll:true});
  });
  track.addEventListener('click', event => {
    if (dragged && event.detail && event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  for (const type of ['pointerup','pointercancel']) window.addEventListener(type, event => {
    if (pointer?.id !== event.pointerId) return;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    pointer = null;
  });
}
enableSegmentDrag($('filters'), 'button');
$('filters').addEventListener('click', event => {
  const button = event.target.closest('button[data-provider]');
  if (!button || button.dataset.provider === activeProvider) return;
  const indicator = $('filters').querySelector('.filter-indicator');
  const motion = matchMedia('(prefers-reduced-motion: no-preference)').matches;
  const classic = document.documentElement.dataset.theme === 'classic';
  const previous = indicator.parentElement;
  button.append(indicator);
  activeProvider = button.dataset.provider;
  for (const filter of $('filters').querySelectorAll('button')) filter.setAttribute('aria-pressed', String(filter === button));
  shown = pageSize;
  renderLibrary();
  if (!motion && !classic) return;
  if (!classic) {
    const grid = $('games');
    for (const animation of grid.getAnimations()) animation.cancel();
    if (grid.childElementCount) grid.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    return;
  }
  moveSegment($('filters'), previous, button);
});
function enhanceSort(select) {
  const picker = node('fieldset', undefined, 'sort-segments');
  picker.append(node('legend', '排序方式', 'sr-only'));
  const shortLabels = { time: '时长', recent: '最近', title: '名称' };
  const choices = Array.from(select.options, option => {
    const label = node('label');
    const input = node('input');
    input.type = 'radio';
    input.name = 'library-sort';
    input.className = 'sr-only';
    input.value = option.value;
    const previousLabel = () => choices.find(choice => choice.value === select.value)?.parentElement;
    input.addEventListener('change', () => {
      moveSegment(picker, previousLabel(), label);
      select.value = input.value;
      select.dispatchEvent(new Event('change'));
    });
    input.setAttribute('aria-label', option.textContent);
    label.append(input, node('span', shortLabels[option.value] ?? option.textContent));
    picker.append(label);
    return input;
  });
  function update() {
    for (const input of choices) input.checked = input.value === select.value;
  }
  select.addEventListener('change', update);
  window.addEventListener('pageshow', update);
  const native = select.closest('label');
  native.after(picker);
  native.classList.add('native-sort');
  enableSegmentDrag(picker, 'label');
  update();
}

enhanceSort($('sort'));
for (const [control, event] of [['search', 'input'], ['sort', 'change']]) {
  $(control).addEventListener(event, () => { shown = pageSize; renderLibrary(); });
}
$('more').addEventListener('click', () => { shown += pageSize; renderLibrary(true); });
$('detail').addEventListener('close', () => modalRequest?.abort());

async function updateOwnerEntry() {
  try {
    const { authenticated } = await data('session');
    const entry = $('owner-entry');
    const label = authenticated === true ? '连接平台' : '登录';
    entry.setAttribute('aria-label', label);
    entry.title = label;
    entry.href = authenticated === true ? '/connect.html' : '/api/profile?resource=connect-login';
  } catch { /* Keep the login entry when session status is unavailable. */ }
}
updateOwnerEntry();
window.addEventListener('pageshow', event => { if (event.persisted) updateOwnerEntry(); });

async function init() {
  const { mode, issues } = await data('setup');
  const note = $('profile-note');
  if (mode === 'demo') {
    note.textContent = '演示数据 · 非真实记录';
    note.dataset.demo = '';
    note.hidden = false;
  }
  if (mode === 'incomplete') {
    note.replaceChildren(node('strong', '部署配置尚未完成'));
    const rules = {
      STEAM_ID: '请填写 17 位纯数字的 SteamID64。',
      STEAM_WEB_API_KEY: '请填写 32 位十六进制字符，只粘贴 Key。',
      PROFILE_PASSWORD: '请填写 12–120 位可打印 ASCII 字符，不含空格、中文或 emoji。',
    };
    const list = node('ul');
    for (const [name, rule] of Object.entries(rules)) {
      const issue = issues?.[name];
      if (issue !== 'missing' && issue !== 'invalid') continue;
      const row = node('li');
      row.append(node('code', name), issue === 'missing' ? '：未配置。' : '：格式不正确。', rule);
      list.append(row);
    }
    if (list.childElementCount) note.append(list);
    const help = node('a', '查看配置指南');
    help.href = '/setup.html#platform-storage';
    const next = node('p');
    next.append('在 Vercel → Settings → Environment Variables 修正后，重新部署。 ', help);
    note.append(next);
    note.hidden = false;
    $('overview').hidden = true;
    $('library').hidden = true;
    return;
  }
  await Promise.all([
    data('now-playing').then(renderActivity, () => renderActivity({ state: 'unknown' })),
    data('identities').then(renderIdentities, () => {}),
    data('library').then(payload => {
      skeleton.remove();
      showLibrary(payload);
      for (const cover of $('games').querySelectorAll('li:nth-child(-n+6) .cover')) {
        if (cover.classList.contains('art-pending')) cover.dataset.reveal = '';
      }
    }, () => {
      skeleton.remove();
      $('library-status').textContent = '未能读取游戏库，请刷新页面重试。';
      $('overview-note').textContent = '无法读取平台同步状态。';
    }),
  ]);
}

const skeleton = librarySkeleton();
init().catch(() => {
  $('library-status').textContent = '未能连接档案服务，请刷新页面重试。';
  renderActivity({ state: 'unknown' });
  $('overview-note').textContent = '无法读取平台同步状态。';
}).finally(() => skeleton.remove());
