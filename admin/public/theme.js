// Theme: "auto" follows the device's light/dark setting; "light"/"dark" are the admin's explicit choice, remembered in this browser.
// Loaded in <head> (not deferred) so the right colors apply before first paint. External file: the admin CSP forbids inline scripts.
(function () {
  var KEY = "ntagz.admin.theme", MODES = ["auto", "light", "dark"];
  var LABEL = { auto: "Auto", light: "Light", dark: "Dark" }, NAME = { auto: "Theme: automatic (follows your device)", light: "Theme: light", dark: "Theme: dark" };
  function read() { try { var v = localStorage.getItem(KEY); return MODES.indexOf(v) >= 0 ? v : "auto"; } catch (e) { return "auto"; } }
  function apply(mode) {
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
  }
  apply(read());
  // The header button (app.html only) cycles auto -> light -> dark. Wired once the DOM exists.
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("theme");
    if (!b) return;
    var show = function (m) { b.textContent = LABEL[m]; b.setAttribute("aria-label", NAME[m] + ". Click to change."); b.title = NAME[m]; };
    show(read());
    b.addEventListener("click", function () {
      var next = MODES[(MODES.indexOf(read()) + 1) % MODES.length];
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: applies to this page only */ }
      apply(next); show(next);
      document.dispatchEvent(new CustomEvent("themechange"));
    });
  });
})();
