// Apply the saved choice before CSS paints; no theme flash or server state.
(() => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  try { const saved = localStorage.getItem('phoenix-theme'); if (['system', 'light', 'dark'].includes(saved)) choice = saved; } catch { /* Storage is optional. */ }
  function apply() {
    const theme = choice === 'system' ? media.matches ? 'dark' : 'light' : choice;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#181c19' : '#f6f4f0');
  }
  media.addEventListener('change', apply); apply();
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.querySelector('#theme'); select.value = choice;
    select.addEventListener('change', () => {
      choice = select.value;
      try { localStorage.setItem('phoenix-theme', choice); } catch { /* Storage is optional. */ }
      apply();
    });
  });
})();
