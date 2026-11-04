// Paste into the DevTools console on https://en32.the-west.net/game.php while logged in, in the
// browser you normally play with. It runs the game's own Fingerprint2 (v1.8.0) with the exact
// options game.php uses and copies a profile JSON to your clipboard. Save it as
// tw-cli/fingerprint-profile.json (gitignored). Nothing is sent anywhere.
(() => {
  if (typeof Fingerprint2 !== 'function') {
    console.error('Fingerprint2 not found: run this on the game page (game.php) after it loaded.');
    return;
  }
  var options = {
    excludeDoNotTrack: true,
    excludeUserAgent: true,
    excludeHasLiedOs: true,
    excludePlugins: true,
  };
  new Fingerprint2(options).get((fp, components) => {
    var profile = {
      version: 1,
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      languages: Array.from(navigator.languages || [navigator.language]),
      webdriver: navigator.webdriver === undefined ? null : navigator.webdriver,
      fp: fp,
      components: components,
    };
    var json = JSON.stringify(profile, null, 2);
    try {
      copy(json);
      console.log(`Fingerprint profile copied to clipboard (fp=${fp}).`);
    } catch {
      console.log(json);
    }
  });
})();
