/*
 * Runs synchronously in <head> so the first paint already uses the stored
 * theme. The gateway CSP forbids inline scripts and main.tsx runs after the
 * first paint. Keep the storage key and colors in sync with src/theme.ts;
 * changing this file requires bumping CACHE_NAME in public/sw.js.
 */
;(function () {
  try {
    var preference = localStorage.getItem('universe.mobile.theme')
    var dark =
      preference === 'dark' ||
      (preference !== 'light' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    var theme = dark ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#0b1120' : '#f3f4f6')
  } catch (error) {
    // Keep the CSS light default.
  }
})()
