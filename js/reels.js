/* Instagram reels showcase. To add a reel, append its shortcode (the part after /reel/ in the URL). */
(function () {
  var REELS = ['DcWxPy1OuX8', 'DZfBMdxOrx_', 'DZcQR5Wuggf', 'DZMIwJsI9e3', 'DZMBGBPIbV7', 'DZK3FD6oQP8'];
  var track = document.getElementById('reels-track');
  if (!track) return;
  var PLAY = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="rgba(255,255,255,.18)" stroke="#fff" stroke-width="2"/><path d="M26 20l20 12-20 12z" fill="#fff"/></svg>';
  var frames = [];
  track.textContent = '';
  REELS.forEach(function (id, i) {
    var card = document.createElement('div');
    card.className = 'reel-card';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reel-play';
    btn.setAttribute('aria-label', 'Play ntagz reel ' + (i + 1));
    btn.innerHTML = '<small>REEL ' + (i + 1) + '</small>' + PLAY + '<span>Tap to play</span>';
    btn.addEventListener('click', function () {
      var f = document.createElement('iframe');
      f.src = 'https://www.instagram.com/reel/' + id + '/embed/';
      f.title = 'ntagz Instagram reel ' + (i + 1);
      f.allow = 'autoplay; encrypted-media; fullscreen';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      frames.push(f);
      card.textContent = '';
      card.appendChild(f);
    });
    card.appendChild(btn);
    track.appendChild(card);
  });

  // Instagram's embed reports its real height; size each iframe to it so nothing is clipped.
  window.addEventListener('message', function (e) {
    if (e.origin !== 'https://www.instagram.com') return;
    var d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return; } }
    if (!d || d.type !== 'MEASURE' || !d.details || !(d.details.height > 0)) return;
    for (var k = 0; k < frames.length; k++) {
      if (frames[k].contentWindow === e.source) { frames[k].style.height = Math.ceil(d.details.height) + 'px'; break; }
    }
  });

  var nav = document.createElement('div');
  nav.className = 'reels-nav';
  [['←', -1, 'Previous reels'], ['→', 1, 'Next reels']].forEach(function (b) {
    var el = document.createElement('button');
    el.type = 'button';
    el.textContent = b[0];
    el.setAttribute('aria-label', b[2]);
    el.addEventListener('click', function () {
      track.scrollBy({ left: b[1] * track.clientWidth * 0.8, behavior: 'smooth' });
    });
    nav.appendChild(el);
  });
  track.parentNode.appendChild(nav);
})();
