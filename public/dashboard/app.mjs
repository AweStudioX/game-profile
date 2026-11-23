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
};

function platformTag(id, text = label(id)) {
  const tag = node('span', undefined, 'platform-tag');
  const brand = /^ps[345]$/.test(id) ? 'psn' : /^(nintendo|switch)/i.test(id) ? 'nintendo' : id;
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
  const earnedAt = recordDate(unlock.unlockedAt, '解锁于');
  if (earnedAt) metadata.append(earnedAt);
  if (Number.isFinite(unlock.rarityPercent)) metadata.append(node('span', `全球解锁率 ${percent(unlock.rarityPercent)}`));
  if (metadata.childElementCount) body.append(metadata);
  row.append(thumbnail, body);
  return row;
}

function renderSources(sources, isDemo) {
  const ids = new Set(['steam', 'psn', 'nintendo', ...Object.keys(sources).filter(id => sources[id]?.status !== 'disabled')]);
  $('sources').replaceChildren(...Array.from(ids, id => {
    const source = sources[id];
    const row = node('li', undefined, 'record-meta');
    row.append(platformTag(id));
    const status = source?.status ?? (id === 'nintendo' ? 'disabled' : null);
    const canConnect = !isDemo && ['steam', 'psn', 'nintendo'].includes(id)
      && (!status || ['disabled', 'not-configured', 'reconnect-required'].includes(status));
    const badge = node(canConnect ? 'a' : 'span', canConnect ? (status === 'reconnect-required' ? '重新连接' : '去连接') : sourceLabel(status), 'badge');
    if (canConnect) badge.href = `/connect.html#${id}-title`;
    if (status === 'ready') badge.dataset.tone = 'active';
    row.append(badge);
    const updated = recordDate(source?.lastSuccessAt, '同步于');
    if (updated) {
      updated.classList.add('sync-date');
      row.append(updated);
    }
    const count = model.providerCounts[id];
    if (count !== undefined) row.append(node('span', `${number.format(count)} 个游戏`, 'source-count'));
    return row;
  }));
}

function renderActivity(payload) {
  const activity = $('activity');
  const sessions = payload.state === 'playing' && Array.isArray(payload.sessions) ? payload.sessions : [];
  const live = sessions.length > 0;
  $('activity-status').textContent = live ? '游玩中' : payload.state === 'offline' ? '未检测到游玩' : '状态未知';
  $('activity-status').dataset.tone = live ? 'active' : '';
  activity.replaceChildren(...sessions.map(session => {
    const item = node('div', undefined, 'catalog-session');
    item.append(node('span', '正在游玩', 'catalog-live'), node('strong', session.game?.name ?? '未命名游戏'));
    const origins = new Set([session.primarySource, session.platform].filter(id => id && id !== 'unknown'));
    for (const id of origins) item.append(platformTag(id));
    return item;
  }));
  if (!live) activity.append(node('p', payload.state === 'offline'
    ? '已检查的平台未报告正在游玩的游戏。' : '暂无可用的活动快照。', 'muted'));
  const sources = node('ul', undefined, 'activity-sources');
  sources.setAttribute('aria-label', '活动快照来源与时间');
  for (const [provider, source] of Object.entries(payload.sources ?? {})) {
    if (source.status === 'disabled') continue;
    const row = node('li', undefined, 'record-meta');
    row.append(platformTag(provider));
    const updated = recordDate(source.lastSuccessAt, '观测于');
    if (updated) row.append(updated);
    if (source.status !== 'ready') row.append(node('span', sourceLabel(source.status)));
    sources.append(row);
  }
  if (sources.childElementCount) activity.append(sources);
}

function identityAvatar(provider, value) {
  const avatar = node('span', undefined, 'identity-avatar');
  avatar.setAttribute('aria-hidden', 'true');
  const fallback = platformTag(provider, '');
  avatar.append(fallback);
  const url = imageUrl(value);
  if (!url) return avatar;
  const image = node('img');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => fallback.remove(), { once: true });
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = url;
  avatar.append(image);
  return avatar;
}

function renderIdentities(payload) {
  const entries = ['steam', 'psn', 'nintendo']
    .map(id => [id, payload?.identities?.[id]])
    .filter(([, identity]) => identity && (identity.displayName || identity.id));
  if (!entries.length) return;
  $('identity-list').replaceChildren(...entries.map(([id, identity], index) => {
    const item = node('li', undefined, 'identity');
    item.style.setProperty('--i', String(index));
    item.append(identityAvatar(id, identity.avatarUrl));
    const copy = node('span', undefined, 'identity-copy');
    copy.append(node('strong', identity.displayName || identity.id, 'identity-name'));
    const meta = node('span', undefined, 'identity-meta muted');
    meta.append(platformTag(id));
    if (identity.id && identity.displayName && identity.id !== identity.displayName) {
      meta.append(node('span', identity.id));
    }
    copy.append(meta);
    item.append(copy);
    return item;
  }));
  $('identities').hidden = false;
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

function showLibrary(payload, isDemo) {
  model = libraryModel(payload);
  renderSources(model.sources, isDemo);
  if (!Array.isArray(payload.games) || payload.status === 'unavailable') {
    const link = node('a', '检查平台连接');
    link.href = '/connect.html';
    const hasConnection = Object.values(model.sources).some(source => !['disabled', 'not-configured'].includes(source.status));
    $('library-status').replaceChildren(hasConnection ? '游戏库暂不可用。 ' : '还没有连接游戏账号。 ', link);
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
      showLibrary(payload, mode === 'demo');
      for (const cover of $('games').querySelectorAll('li:nth-child(-n+6) .cover')) {
        if (cover.classList.contains('art-pending')) cover.dataset.reveal = '';
      }
    }, () => {
      skeleton.remove();
      $('library-status').textContent = '未能读取游戏库，请刷新页面重试。';
      $('sources').replaceChildren(node('li', '无法读取平台同步状态。'));
    }),
  ]);
}

const skeleton = librarySkeleton();
init().catch(() => {
  $('library-status').textContent = '未能连接档案服务，请刷新页面重试。';
  renderActivity({ state: 'unknown' });
  $('sources').replaceChildren(node('li', '无法读取平台同步状态。'));
}).finally(() => skeleton.remove());
