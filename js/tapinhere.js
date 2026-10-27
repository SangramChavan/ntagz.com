// Run animations only while their section is on screen (CPU saver). Without JS, animations simply run.
(function () {
  document.documentElement.classList.add('js'); // gates off-screen pausing; without JS animations just run
  var els = document.querySelectorAll('[data-mo]');
  if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('on'); }); return; }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { en.target.classList.toggle('on', en.isIntersecting); });
  }, { rootMargin: '80px' });
  els.forEach(function (e) { io.observe(e); });
  window.addEventListener('pagehide', function () { io.disconnect(); });
})();
