(() => {
  const key = 'game-profile-theme';
  const schemeKey = 'game-profile-scheme';
  const root = document.documentElement;
  const themes = { classic: '经典', pixel: '像素', neon: '霓虹都市' };
  const savedTheme = () => {
    try {
      const value = localStorage.getItem(key);
      return Object.hasOwn(themes, value) ? value : 'classic';
    } catch { return 'classic'; }
  };
  const readScheme = () => {
    try {
      const value = localStorage.getItem(schemeKey);
      return value === 'light' || value === 'dark' ? value : null;
    } catch { return null; }
  };
  root.dataset.theme = savedTheme();
  const savedScheme = readScheme();
  if (savedScheme) root.dataset.scheme = savedScheme;

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const shapes = {
      theme: '<path d="M4 7h10M18 7h2M4 12h2.5M10.5 12H20M4 17h10M18 17h2"/><circle cx="15.5" cy="7" r="2.2"/><circle cx="7.5" cy="12" r="2.2"/><circle cx="15.5" cy="17" r="2.2"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
      moon: '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a7 7 0 0 0 10.7 10.7Z"/>',
    };
    svg.innerHTML = shapes[name].replace(/fill="[^"]*"/g, '')
      .replace(/<path /g, '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ')
      .replace(/<circle /g, '<circle fill="none" stroke="currentColor" stroke-width="1.5" ');
    return svg;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.querySelector('.theme-picker');
    const trigger = document.createElement('button');
    trigger.className = 'theme-toggle';
    trigger.type = 'button';
    trigger.setAttribute('aria-controls', 'theme-options');
    trigger.setAttribute('aria-label', '主题');
    trigger.setAttribute('title', '主题');
    trigger.append(icon('theme'));
    const menu = document.createElement('div');
    menu.id = 'theme-options';
    menu.className = 'theme-options';
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', '外观主题');
    const options = Object.entries(themes).map(([theme, name]) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = name;
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      check.setAttribute('class', 'theme-check');
      check.setAttribute('viewBox', '0 0 20 20');
      check.setAttribute('aria-hidden', 'true');
      const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      checkPath.setAttribute('d', 'M5 10.25 8.25 13.5 15 6.75');
      checkPath.setAttribute('fill', 'none');
      checkPath.setAttribute('stroke', 'currentColor');
      checkPath.setAttribute('stroke-width', '1.75');
      checkPath.setAttribute('stroke-linecap', 'round');
      checkPath.setAttribute('stroke-linejoin', 'round');
      check.append(checkPath);
      option.append(check);
      option.addEventListener('click', () => {
        apply(theme);
        try { localStorage.setItem(key, theme); } catch { /* The page still switches themes. */ }
        setOpen(false);
        trigger.focus();
      });
      return [theme, option];
    });
    function apply(theme) {
      root.dataset.theme = theme;
      for (const [value, option] of options) option.setAttribute('aria-pressed', String(theme === value));
    }
    function setOpen(open) {
      trigger.setAttribute('aria-expanded', String(open));
      menu.inert = !open;
      menu.hidden = !open;
    }
    menu.append(...options.map(([, option]) => option));
    picker.append(trigger, menu);
    apply(root.dataset.theme);
    setOpen(false);
    trigger.addEventListener('click', () => setOpen(menu.hidden));
    picker.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || menu.hidden) return;
      event.preventDefault();
      setOpen(false);
      trigger.focus();
    });
    picker.addEventListener('focusout', event => {
      if (event.relatedTarget && !picker.contains(event.relatedTarget)) setOpen(false);
    });
    document.addEventListener('click', event => {
      if (!menu.hidden && !picker.contains(event.target)) setOpen(false);
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) {
        apply(savedTheme());
        setOpen(false);
      }
    });
    window.addEventListener('storage', event => {
      if (event.key === key || event.key === null) apply(savedTheme());
    });

    const schemeBtn = document.getElementById('scheme-toggle');
    if (schemeBtn) {
      const darkMedia = matchMedia('(prefers-color-scheme: dark)');
      const currentScheme = () => (
        root.dataset.scheme === 'light' || root.dataset.scheme === 'dark'
          ? root.dataset.scheme
          : (darkMedia.matches ? 'dark' : 'light')
      );
      function renderScheme() {
        const scheme = currentScheme();
        const next = scheme === 'dark' ? '浅色' : '深色';
        schemeBtn.setAttribute('aria-label', `切换到${next}模式`);
        schemeBtn.title = `切换到${next}模式`;
        schemeBtn.replaceChildren(icon(scheme === 'dark' ? 'sun' : 'moon'));
      }
      schemeBtn.addEventListener('click', () => {
        const scheme = currentScheme() === 'dark' ? 'light' : 'dark';
        root.dataset.scheme = scheme;
        renderScheme();
        try { localStorage.setItem(schemeKey, scheme); } catch { /* The page still switches schemes. */ }
      });
      renderScheme();
      window.addEventListener('storage', event => {
        if (event.key !== schemeKey && event.key !== null) return;
        const saved = readScheme();
        if (saved) root.dataset.scheme = saved; else delete root.dataset.scheme;
        renderScheme();
      });
      window.addEventListener('pageshow', event => { if (event.persisted) renderScheme(); });
    }
  });
})();
