(() => {
  const key = 'game-profile-theme';
  const root = document.documentElement;
  const themes = ['classic', 'pixel', 'neon'];
  const savedTheme = () => {
    try {
      const value = localStorage.getItem(key);
      return themes.includes(value) ? value : 'classic';
    } catch { return 'classic'; }
  };
  root.dataset.theme = savedTheme();
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.querySelector('.theme-toggle');
    const apply = theme => {
      root.dataset.theme = theme;
      picker.value = theme;
    };
    apply(root.dataset.theme);
    picker.hidden = false;
    picker.addEventListener('change', () => {
      const theme = picker.value;
      apply(theme);
      try { localStorage.setItem(key, theme); } catch { /* The current page still switches themes. */ }
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) apply(savedTheme());
    });
    window.addEventListener('storage', event => {
      if (event.key === key || event.key === null) apply(savedTheme());
    });
  });
})();
