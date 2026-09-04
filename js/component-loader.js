/**
 * Component Loader - Injects reusable header and footer across all pages
 * Automatically adjusts relative paths based on page depth
 */

(function() {
  'use strict';

  // Determine the base path for relative links
  function getBasePath() {
    const pathname = window.location.pathname;
    // Count the depth: /product/xxx/index.html = 2 levels, /index.html = 0
    const segments = pathname.split('/').filter(s => s && s !== 'index.html');
    
    // If we're in a subdirectory (like /product/xxx/), we need to go up
    // We count non-empty segments excluding the filename
    let depth = 0;
    const path = pathname;
    
    // Count directories before the filename
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] && parts[i] !== '' && parts[i] !== 'index.html') {
        depth++;
      }
    }
    
    // Generate relative path (e.g., "../" for 1 level, "../../" for 2 levels)
    if (depth === 0) return '';
    return '../'.repeat(depth);
  }

  // Replace all {{BASE_PATH}} placeholders with the calculated base path
  function replacePaths(html, basePath) {
    return html.replace(/\{\{BASE_PATH\}\}/g, basePath);
  }

  // Mobile hamburger menu: nav-links is hidden below 768px with no
  // other way to reach it, so wire the toggle + panel the header
  // markup ships with.
  function wireMobileMenu(scope) {
    const toggle = scope.querySelector('.menu-toggle');
    const panel = scope.querySelector('.mobile-nav-panel');
    if (!toggle || !panel) return;

    function close() {
      panel.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open menu');
    }

    toggle.addEventListener('click', function () {
      const open = panel.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });

    // Tapping a link, resizing past the mobile breakpoint, or
    // pressing Escape should all close the panel.
    panel.addEventListener('click', function (e) {
      if (e.target.closest('a')) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 768) close();
    });
  }

  // Load and inject components
  async function loadComponents() {
    const basePath = getBasePath();
    const componentPath = basePath + 'components/';

    try {
      // Load header
      const headerResponse = await fetch(componentPath + 'header.html');
      if (headerResponse.ok) {
        let headerHtml = await headerResponse.text();
        headerHtml = replacePaths(headerHtml, basePath);
        
        const headerPlaceholder = document.getElementById('header-placeholder');
        if (headerPlaceholder) {
          headerPlaceholder.innerHTML = headerHtml;
          wireMobileMenu(headerPlaceholder);
          document.dispatchEvent(new CustomEvent('ntagz:header-loaded'));
        }
      }

      // Load footer
      const footerResponse = await fetch(componentPath + 'footer.html');
      if (footerResponse.ok) {
        let footerHtml = await footerResponse.text();
        footerHtml = replacePaths(footerHtml, basePath);
        
        const footerPlaceholder = document.getElementById('footer-placeholder');
        if (footerPlaceholder) {
          footerPlaceholder.innerHTML = footerHtml;
        }
      }
    } catch (error) {
      console.warn('Component loader error:', error);
    }
  }

  // Load components when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadComponents);
  } else {
    loadComponents();
  }
})();
