const $ = id => document.getElementById(id);
const endpoint = resource => `/api/profile?resource=${resource}`;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const statuses = {
  ready: '已同步', stale: '待刷新', connected: '已连接', 'not-configured': '未连接',
  'reconnect-required': '需要重连', private: '隐私受限', unavailable: '暂不可用',
};
const errors = {
  'invalid-steam-id': 'SteamID64 必须是 17 位数字。',
  'invalid-steam-key': 'Steam Web API Key 必须是 32 位十六进制字符。',
  'steam-library-validation-failed': 'Steam 未返回游戏库。请核对 SteamID64、Key 和游戏详情隐私设置。',
  'invalid-npsso-format': '授权结果格式不正确，请从 Sony 页面重新复制。',
  'invalid-callback': '请复制 Nintendo 页面上的完整链接，不要只复制其中一段。',
  'state-mismatch': '链接不属于本次登录，请重新生成链接。',
  'confirmation-expired': '确认已过期，请重新识别账号。',
  'reconnect-required': '平台需要重新授权。',
  'sync-busy': '此平台正在处理另一项操作，请稍后重试。',
  'rate-limited': '平台暂时限流，请稍后重试。',
  'owner-account-mismatch': '账号和当前绑定不同，请使用原账号，或先断开连接。',
  'account-mismatch': '账号和当前绑定不同，请使用原账号，或先断开连接。',
  'disconnect-before-reconnecting': '账号仍处于连接状态。如需切换，请先断开连接。',
  'credential-integrity-failed': '无法读取已保存的会话，请确认部署使用原来的加密密钥。',
};
let confirmationId;

async function refreshStatus() {
  const response = await fetch(endpoint('platforms'), { cache: 'no-store' });
  const note = $('connect-status');
  if (response.status === 401) {
    const login = document.createElement('a');
    login.href = endpoint('connect-login');
    login.textContent = '登录后配置平台';
    note.replaceChildren(login);
    return;
  }
  if (!response.ok) {
    const guide = document.createElement('a');
    guide.href = '/setup.html#platform-storage';
    guide.textContent = '先完成部署配置';
    note.replaceChildren(guide);
    return;
  }
  const { storage, sources, sync } = await response.json();
  if (storage !== 'configured' || !sync) {
    const guide = document.createElement('a');
    guide.href = '/setup.html#platform-storage';
    guide.textContent = '查看数据库配置步骤';
    note.replaceChildren(storage === 'invalid-config' ? '数据库配置格式不正确。 '
      : storage === 'configured' ? '无法读取平台存储，请检查数据库和加密密钥。 ' : '还没有配置平台存储。 ', guide);
    return;
  }
  note.textContent = '选择平台完成连接。凭证保存在服务端，不会回显。';
  $('owner-platforms').hidden = false;
  $('sync-settings').hidden = false;
  $('schedule-form').elements.cadence.value = sync.cadence;
  $('sync-last').textContent = sync.lastScheduledAt
    ? `最近一次定时同步触发：${new Date(sync.lastScheduledAt).toLocaleString()}` : '尚未触发定时同步。';
  for (const id of ['steam', 'psn', 'nintendo']) {
    const source = sources[id];
    const status = source?.status ?? 'not-configured';
    const state = $(`${id}-status`);
    state.textContent = statuses[status] ?? '状态未知';
    state.dataset.tone = status === 'ready' ? 'active' : '';
    const synced = $(`${id}-synced`);
    const timestamp = Date.parse(source?.lastSuccessAt);
    synced.parentElement.hidden = !Number.isFinite(timestamp);
    if (!synced.parentElement.hidden) {
      synced.dateTime = new Date(timestamp).toISOString();
      synced.textContent = dateFormat.format(timestamp);
    }
    if (id === 'psn') $('psn-form').hidden = ['connected', 'ready', 'stale'].includes(status);
    $(`${id}-actions`).hidden = status === 'not-configured';
  }
}

async function perform(provider, action, body = {}, done) {
  const panel = $(`${provider}-title`).closest('section');
  const buttons = [...panel.querySelectorAll('button')];
  if (buttons.some(button => button.disabled)) return;
  for (const button of buttons) button.disabled = true;
  const result = $(`${provider}-result`);
  result.textContent = '正在处理…';
  try {
    const response = await fetch(endpoint('platform-action'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, action, ...body }),
    });
    if (response.status === 401) throw new Error('signed-out');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (done) result.textContent = done(data);
    else {
      result.textContent = action === 'schedule' ? '同步频率已保存。' : statuses[data.status] ?? '操作完成';
      await refreshStatus();
    }
  } catch (error) {
    result.textContent = error.message === 'signed-out' ? '请重新登录看板。'
      : Object.hasOwn(errors, error.message) ? errors[error.message] : '操作未完成。请检查授权状态或稍后重试。';
  } finally { for (const button of buttons) button.disabled = false; }
}

$('schedule-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform('profile', 'schedule', { cadence: event.currentTarget.elements.cadence.value });
});
$('steam-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const { steamId, apiKey } = Object.fromEntries(new FormData(form));
  form.elements.apiKey.value = '';
  void perform('steam', 'configure', { steamId, apiKey });
});
$('psn-form').addEventListener('submit', event => {
  event.preventDefault();
  const npsso = new FormData(event.currentTarget).get('npsso')?.trim();
  event.currentTarget.reset();
  confirmationId = undefined;
  $('psn-review').hidden = true;
  void perform('psn', 'identify', { npsso }, data => {
    confirmationId = data.confirmationId;
    $('psn-owner').textContent = data.onlineId;
    $('psn-review').hidden = false;
    return '请核对账号后确认。';
  });
});
$('psn-confirm').addEventListener('click', () => {
  const id = confirmationId;
  confirmationId = undefined;
  $('psn-review').hidden = true;
  if (id) void perform('psn', 'confirm', { confirmationId: id });
});
$('nintendo-start').addEventListener('click', () => {
  $('nintendo-auth').hidden = true;
  $('nintendo-form').hidden = true;
  void perform('nintendo', 'start', {}, data => {
    const url = new URL(data.url);
    if (url.origin !== 'https://accounts.nintendo.com') throw new Error('invalid-url');
    $('nintendo-auth').href = url.href;
    $('nintendo-auth').hidden = false;
    $('nintendo-form').hidden = false;
    return '请打开官网完成登录，再粘贴回调链接。';
  });
});
$('nintendo-form').addEventListener('submit', event => {
  event.preventDefault();
  const callback = new FormData(event.currentTarget).get('callback')?.trim();
  event.currentTarget.reset();
  $('nintendo-form').hidden = true;
  $('nintendo-auth').hidden = true;
  $('nintendo-auth').removeAttribute('href');
  void perform('nintendo', 'confirm', { callback });
});
$('owner-platforms').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { provider, action } = button.dataset;
  if (action === 'disconnect' && !window.confirm('断开后会删除本站保存的该平台会话和同步快照。继续？')) return;
  if (action === 'disconnect' && provider === 'nintendo') {
    $('nintendo-form').hidden = true;
    $('nintendo-auth').hidden = true;
    $('nintendo-auth').removeAttribute('href');
  }
  if (action === 'disconnect' && provider === 'psn') {
    confirmationId = undefined;
    $('psn-review').hidden = true;
  }
  void perform(provider, action);
});
refreshStatus().catch(() => { $('connect-status').textContent = '无法读取状态，请刷新页面。'; });
