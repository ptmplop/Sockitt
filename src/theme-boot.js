// A theme chosen for this device (Settings › Appearance), applied before the
// first paint. The preference itself lives in chrome.storage, which only
// answers asynchronously — a page that waited for it painted in the system's
// theme and then flipped. applyTheme (shared/state.ts) keeps this synchronous
// mirror current. A classic script, not a module, so it blocks the paint.
try {
  const theme = localStorage.getItem('sockitt-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  /* storage unavailable: the system theme stands until the page script runs */
}
