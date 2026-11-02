/* Instagram reels showcase. To add a reel, append its shortcode (the part after /reel/ in the URL). */
(function () {
  var REELS = ['DcWxPy1OuX8', 'DZfBMdxOrx_', 'DZcQR5Wuggf', 'DZMIwJsI9e3', 'DZMBGBPIbV7', 'DZK3FD6oQP8'];
  var track = document.getElementById('reels-track');
  if (!track) return;
  var PLAY = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="rgba(255,255,255,.18)" stroke="#fff" stroke-width="2"/><path d="M26 20l20 12-20 12z" fill="#fff"/></svg>';
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
      card.textContent = '';
      card.appendChild(f);
    });
    card.appendChild(btn);
    track.appendChild(card);
  });
})();
