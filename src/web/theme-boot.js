/**
 * 首帧主题：在 CSS 之前跑，按系统偏好先上色，避免亮色系统下闪一下深色。
 * 拿不到系统偏好时按要求回落亮白。
 */
(function () {
  var theme = 'light';
  try {
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq && typeof mq.matches === 'boolean') theme = mq.matches ? 'dark' : 'light';
    }
  } catch (e) {
    theme = 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
