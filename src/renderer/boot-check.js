/* Classic (non-module) script: if the ES module graph never boots — e.g. a host
   that blocks module scripts over file:// — say so visibly instead of showing a
   blank window. Runs once, costs nothing when the app boots normally. */
(function () {
  var TIMEOUT = 2500;
  window.setTimeout(function () {
    if (window.__nxhubBooted) return;
    var box = document.getElementById('boot-warning');
    if (!box) return;
    box.hidden = false;
    box.className = 'boot-warning';
    box.textContent =
      'Renderer modules did not load. If this page was opened directly from disk, ' +
      'serve it over http instead: node test/ui/serve.mjs';
  }, TIMEOUT);
})();
