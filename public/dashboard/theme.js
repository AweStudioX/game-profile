(() => {
  const key = 'game-profile-theme';
  const root = document.documentElement;
  const savedTheme = () => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  root.dataset.theme = savedTheme() === 'pixel' ? 'pixel' : 'classic';
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('.theme-toggle');
    const apply = theme => {
      root.dataset.theme = theme;
      const pixel = theme === 'pixel';
      button.setAttribute('aria-pressed', String(pixel));
      button.textContent = pixel ? '主题：像素' : '主题：经典';
    };
    apply(root.dataset.theme);
    button.hidden = false;
    button.addEventListener('click', () => {
      const theme = root.dataset.theme === 'pixel' ? 'classic' : 'pixel';
      apply(theme);
      try { localStorage.setItem(key, theme); } catch { /* The current page still switches themes. */ }
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) apply(savedTheme() === 'pixel' ? 'pixel' : 'classic');
    });
    window.addEventListener('storage', event => {
      if (event.key === key || event.key === null) apply(savedTheme() === 'pixel' ? 'pixel' : 'classic');
    });
  });
})();
