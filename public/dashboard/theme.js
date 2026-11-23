(() => {
  const key = 'game-profile-theme';
  const root = document.documentElement;
  const themes = { classic: '经典', pixel: '像素', neon: '霓虹都市' };
  const savedTheme = () => {
    try {
      const value = localStorage.getItem(key);
      return Object.hasOwn(themes, value) ? value : 'classic';
    } catch { return 'classic'; }
  };
  root.dataset.theme = savedTheme();
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.querySelector('.theme-picker');
    const trigger = document.createElement('button');
    trigger.className = 'theme-toggle';
    trigger.type = 'button';
    trigger.setAttribute('aria-controls', 'theme-options');
    const triggerLabel = document.createElement('span');
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.classList.add('theme-chevron');
    chevron.setAttribute('viewBox', '0 0 20 20');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5.5 7.75 10 12.25 14.5 7.75');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.75');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    chevron.append(path);
    trigger.append(triggerLabel, chevron);
    const menu = document.createElement('div');
    menu.id = 'theme-options';
    menu.className = 'theme-options';
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', '外观主题');
    const options = Object.entries(themes).map(([theme, name]) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = name;
      option.addEventListener('click', () => {
        apply(theme);
        try { localStorage.setItem(key, theme); } catch { /* The current page still switches themes. */ }
        setOpen(false);
        trigger.focus();
      });
      return [theme, option];
    });
    function apply(theme) {
      root.dataset.theme = theme;
      triggerLabel.textContent = `主题：${themes[theme]}`;
      for (const [value, option] of options) option.setAttribute('aria-pressed', String(theme === value));
    }
    function setOpen(open) {
      trigger.setAttribute('aria-expanded', String(open));
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
  });
})();
