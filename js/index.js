/* ── PRODUCT FILTER + SEARCH ── */
    var productCat = 'all', productQuery = '';
    function applyProductFilters() {
      var terms = productQuery.toLowerCase().split(/\s+/).filter(Boolean), shown = 0;
      document.querySelectorAll('.product-card').forEach(card => {
        var always = card.dataset.cat === 'always';
        var show = always ? (!terms.length && productCat === 'all')
          : (productCat === 'all' || card.dataset.cat === productCat) &&
            terms.every(t => card.textContent.toLowerCase().includes(t));
        card.style.display = show ? '' : 'none';
        if (show && !always) shown++;
      });
      var empty = document.getElementById('noResults');
      if (empty) {
        empty.hidden = shown > 0;
        document.getElementById('noQuery').textContent = productQuery ? '“' + productQuery + '”' : 'this category';
      }
    }
    function filterProducts(cat, btn) {
      document.querySelectorAll('.ftab').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      productCat = cat;
      applyProductFilters();
    }
    function searchProducts(q) { productQuery = q.trim(); applyProductFilters(); }
    function clearProductFilters() {
      var input = document.getElementById('productSearch');
      if (input) input.value = '';
      productQuery = '';
      filterProducts('all', document.querySelector('.ftab'));
    }

    /* ── PRODUCT IMAGE CAROUSEL (photo + spec sheet) ── */
    function setSlide(btn, idx) {
      const carousel = btn.closest('[data-carousel]');
      carousel.querySelectorAll('.product-photo').forEach((img, i) => {
        img.classList.toggle('active', i === idx);
      });
      carousel.querySelectorAll('.carousel-dots button').forEach((b, i) => {
        b.classList.toggle('active', i === idx);
      });
    }

    /* ── FAQ TOGGLE ── */
    function toggleFaq(el) {
      const item = el.parentElement;
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => {
        i.classList.remove('open');
        i.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
      });
      if (!isOpen) {
        item.classList.add('open');
        el.setAttribute('aria-expanded', 'true');
      }
    }

    /* ── SCROLL REVEAL ── */
    const reveals = document.querySelectorAll('.reveal');
    const revealObs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('in'); revealObs.unobserve(e.target); }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    reveals.forEach(el => revealObs.observe(el));

    /* ── STAGGER grid children ── */
    document.querySelectorAll('.products-grid, .usecases-grid, .testi-grid, .steps-grid').forEach(grid => {
      Array.from(grid.children).forEach((child, i) => {
        child.style.transitionDelay = (i * 0.08) + 's';
        child.classList.add('reveal');
        revealObs.observe(child);
      });
    });

    /* ── ARIA: init faq expanded states ── */
    document.querySelectorAll('.faq-q').forEach(q => {
      q.setAttribute('aria-expanded', q.parentElement.classList.contains('open') ? 'true' : 'false');
    });
