/* About page: optional enhancements only. Everything is readable and every link works without this file. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Gentle reveal on scroll. Skipped for reduced motion or without IntersectionObserver, so content never depends on it. */
  if (!reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('ab-in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.ab-head, .ab-card, .ab-step, .ab-why-item, .ab-aud-card, .ab-company, .ab-story > *, .ab-final .ab-wrap').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) return;          /* already on screen: no flash */
      el.classList.add('ab-pre'); io.observe(el);
    });
  }

  /* Copy the address (the button is hidden until this runs, so it only appears where it works). */
  var btn = document.getElementById('ab-copy-btn'), addr = document.getElementById('ab-address');
  if (btn && addr && navigator.clipboard && navigator.clipboard.writeText) {
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var text = 'Ambivert Technologies Private Limited, ' + addr.textContent.replace(/\s+/g, ' ').trim();
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Address copied';
        setTimeout(function () { btn.textContent = 'Copy address'; }, 2200);
      }, function () { btn.textContent = 'Copy not available'; });
    });
  }
})();
