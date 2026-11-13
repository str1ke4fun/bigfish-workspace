/* 首屏渲染前同步设置主题，避免闪白 / 闪黑。 */
;(function () {
  var theme = 'day'
  try {
    var saved = localStorage.getItem('fish.theme')
    if (saved === 'day' || saved === 'night') theme = saved
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) theme = 'night'
  } catch {
    theme = 'day'
  }
  document.documentElement.dataset.theme = theme
})()
