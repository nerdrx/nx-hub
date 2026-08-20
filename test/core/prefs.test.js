"use strict";
// v0.2 settings: new defaults, appPrefs sanitising merge, effective policies,
// export/import (never a token) and the XDG autostart entry.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const helpers = require("./helpers");
const config = require("../../src/main/config");

function withXdgConfig(dir) {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  return () => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  };
}

test("v0.2 settings defaults match the SPEC", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  const s = config.load();
  assert.deepStrictEqual(s.appPrefs, {});
  assert.strictEqual(s.updatePolicy, "notify");
  assert.strictEqual(s.includePrereleases, false);
  assert.strictEqual(s.notifications, true);
  assert.strictEqual(s.autostart, false);
  assert.strictEqual(s.startMinimized, false);
  assert.strictEqual(s.createDesktopEntries, true);
  assert.strictEqual(s.maxConcurrentDownloads, 2);
  assert.strictEqual(s.preferredDeviceSerial, null);
});

test("v0.10 — setAppPref stamps _ts; the sanitizer preserves it and never invents one", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  const before = Date.now();
  config.setAppPref("wivrn-nx", { favorite: true });
  const stamped = config.getAppPref(config.load(), "wivrn-nx");
  assert.ok(stamped._ts >= before && stamped._ts <= Date.now(), "the WRITE is what mints a stamp");

  // a second write moves it forward; the entry's other keys are untouched
  const first = stamped._ts;
  config.setAppPref("wivrn-nx", { hidden: true });
  const second = config.getAppPref(config.load(), "wivrn-nx");
  assert.ok(second._ts >= first);
  assert.strictEqual(second.favorite, true);

  // READING is not editing. Fleet settings sync decides which of two hubs'
  // copies wins by comparing these, so a stamp minted by the sanitizer would
  // let a machine nobody touched beat the one the user actually typed on.
  config.save({ appPrefs: { quadforge: { favorite: true } } });
  assert.deepStrictEqual(config.getAppPref(config.load(), "quadforge"), { favorite: true }, "never invented");
  assert.deepStrictEqual(config.load().appPrefs.quadforge, config.load().appPrefs.quadforge);

  // …but a stamp that IS there survives every round trip
  config.save({ appPrefs: { ogb: { favorite: true, _ts: 1_700_000_000_000 } } });
  assert.strictEqual(config.getAppPref(config.load(), "ogb")._ts, 1_700_000_000_000);
  assert.strictEqual(config.sanitizeAppPref({ favorite: true, _ts: 1_700_000_000_000.6 })._ts, 1_700_000_000_001);

  // junk stamps are not stamps
  for (const junk of [0, -1, "1700000000000", null, NaN, Infinity, {}, []]) {
    assert.ok(!("_ts" in config.sanitizeAppPref({ favorite: true, _ts: junk })), `_ts: ${JSON.stringify(junk)}`);
  }

  // a caller cannot claim the future through setAppPref — `_ts` is not one of
  // the keys a patch may set, so the write's own clock always wins
  config.setAppPref("pulsenx", { favorite: true, _ts: 4_000_000_000_000 });
  assert.ok(config.getAppPref(config.load(), "pulsenx")._ts < 4_000_000_000_000);
  assert.ok(!config.APP_PREF_KEYS.includes("_ts"));
});

test("v0.10 — fleetSync defaults on and sanitizes like the other booleans", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  assert.strictEqual(config.defaults().fleetSync, true);
  assert.strictEqual(config.load().fleetSync, true);
  config.save({ fleetSync: false });
  assert.strictEqual(config.load().fleetSync, false);
  config.save({ fleetSync: "true" });
  assert.strictEqual(config.load().fleetSync, true);
  config.save({ fleetSync: "nonsense" });
  assert.strictEqual(config.load().fleetSync, true, "junk falls back to the default");
});

test("junk values fall back to the defaults instead of poisoning settings", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  config.save({
    updatePolicy: "explode",
    includePrereleases: "yes-please",
    maxConcurrentDownloads: 0,
    notifications: "nope",
    preferredDeviceSerial: "   ",
    appPrefs: "not an object",
  });
  const s = config.load();
  assert.strictEqual(s.updatePolicy, "notify");
  assert.strictEqual(s.includePrereleases, false);
  assert.strictEqual(s.maxConcurrentDownloads, 2);
  assert.strictEqual(s.notifications, true);
  assert.strictEqual(s.preferredDeviceSerial, null);
  assert.deepStrictEqual(s.appPrefs, {});

  config.save({ maxConcurrentDownloads: 99 });
  assert.strictEqual(config.load().maxConcurrentDownloads, 8, "clamped, not rejected");
  config.save({ preferredDeviceSerial: " PICO123 " });
  assert.strictEqual(config.load().preferredDeviceSerial, "PICO123");
});

test("setAppPref deep-merges one app, drops unknown keys and replaces arrays", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  config.setAppPref("wivrn-nx", {
    updatePolicy: "download",
    launchArgs: ["--vulkan", "--no-fuse"],
    launchEnv: { WIVRN_DEBUG: "1", SHOW: "yes" },
    favorite: true,
    nonsense: "dropped",
    hidden: "not a boolean",
  });
  let prefs = config.getAppPref(config.load(), "wivrn-nx");
  assert.strictEqual(prefs.updatePolicy, "download");
  assert.deepStrictEqual(prefs.launchArgs, ["--vulkan", "--no-fuse"]);
  assert.deepStrictEqual(prefs.launchEnv, { WIVRN_DEBUG: "1", SHOW: "yes" });
  assert.strictEqual(prefs.favorite, true);
  assert.ok(!("nonsense" in prefs), "unknown keys are dropped");
  assert.ok(!("hidden" in prefs), "wrongly typed values are dropped");

  // second patch: merges, does not reset the app's other prefs
  config.setAppPref("wivrn-nx", { skippedVersion: "1.5.0", launchArgs: ["--only-this"] });
  prefs = config.getAppPref(config.load(), "wivrn-nx");
  assert.strictEqual(prefs.updatePolicy, "download", "earlier key survives the merge");
  assert.strictEqual(prefs.skippedVersion, "1.5.0");
  assert.deepStrictEqual(prefs.launchArgs, ["--only-this"], "arrays are REPLACED, not merged");

  // launchEnv is an object → merges key-wise; null removes one key
  config.setAppPref("wivrn-nx", { launchEnv: { EXTRA: "2", SHOW: null } });
  prefs = config.getAppPref(config.load(), "wivrn-nx");
  assert.deepStrictEqual(prefs.launchEnv, { WIVRN_DEBUG: "1", EXTRA: "2" });

  // explicit null clears a preference so the global default applies again
  config.setAppPref("wivrn-nx", { updatePolicy: null });
  assert.ok(!("updatePolicy" in config.getAppPref(config.load(), "wivrn-nx")));

  // other apps are untouched
  config.setAppPref("quadforge", { hidden: true });
  const s = config.load();
  assert.strictEqual(config.getAppPref(s, "quadforge").hidden, true);
  assert.strictEqual(config.getAppPref(s, "wivrn-nx").skippedVersion, "1.5.0");
  assert.deepStrictEqual(config.getAppPref(s, "never-heard-of-it"), {});
});

test("effective policy / prereleases: per-app override wins over the global", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  config.save({ updatePolicy: "download", includePrereleases: true });
  assert.strictEqual(config.effectiveUpdatePolicy(config.load(), "any-app"), "download");
  assert.strictEqual(config.effectiveIncludePrereleases(config.load(), "any-app"), true);

  config.setAppPref("wivrn-nx", { updatePolicy: "install", includePrereleases: false });
  const s = config.load();
  assert.strictEqual(config.effectiveUpdatePolicy(s, "wivrn-nx"), "install");
  assert.strictEqual(config.effectiveIncludePrereleases(s, "wivrn-nx"), false);
  assert.strictEqual(config.effectiveUpdatePolicy(s, "quadforge"), "download", "others keep the global");
});

test("exportSettings never carries the token; importSettings refuses to take one", (t) => {
  const env = helpers.useTempEnv();
  t.after(() => env.cleanup());

  config.save({ token: "ghp_secret", owners: ["nerdrx", "someone-else"], updatePolicy: "download" });
  const json = config.exportSettings();
  assert.ok(!json.includes("ghp_secret"), "token must never be exported");
  const parsed = JSON.parse(json);
  assert.ok(!("token" in parsed));
  assert.deepStrictEqual(parsed.owners, ["nerdrx", "someone-else"]);

  // importing a file that DOES contain a token leaves the stored one alone
  const result = config.importSettings(
    JSON.stringify({
      token: "ghp_attacker",
      owners: ["imported"],
      updatePolicy: "install",
      checkIntervalHours: "junk",
      somethingElse: 1,
      appPrefs: { quadforge: { favorite: true, bogus: 2 } },
    })
  );
  const after = config.load();
  assert.strictEqual(after.token, "ghp_secret", "the stored token survives an import");
  assert.deepStrictEqual(after.owners, ["imported"]);
  assert.strictEqual(after.updatePolicy, "install");
  assert.strictEqual(after.checkIntervalHours, 6, "junk value fell back to the default");
  assert.deepStrictEqual(config.getAppPref(after, "quadforge"), { favorite: true }, "prefs are sanitised on import");

  assert.ok(result.applied.includes("owners") && result.applied.includes("updatePolicy"));
  assert.ok(result.skipped.includes("token"), "the token is reported as skipped");
  assert.ok(result.skipped.includes("somethingElse"), "unknown keys are reported");
  assert.ok(result.skipped.includes("checkIntervalHours"), "rejected values are reported");

  assert.throws(() => config.importSettings("{not json"), /not valid JSON/i);
  assert.throws(() => config.importSettings("[1,2,3]"), /JSON object/i);
});

test("autostart writes and removes ~/.config/autostart/nx-hub.desktop", (t) => {
  const env = helpers.useTempEnv();
  const restore = withXdgConfig(path.join(env.root, "config"));
  t.after(() => {
    restore();
    env.cleanup();
  });

  const exe = "/opt/NX Hub/nx-hub.AppImage";
  const file = config.writeAutostart(exe, { startMinimized: false });
  assert.strictEqual(file, config.autostartPath());
  assert.ok(file.endsWith(path.join("autostart", "nx-hub.desktop")));
  let text = fs.readFileSync(file, "utf8");
  assert.match(text, /^\[Desktop Entry\]/);
  assert.match(text, /^Type=Application$/m);
  assert.match(text, /^Exec="\/opt\/NX Hub\/nx-hub\.AppImage"$/m, "spaces in the path are quoted");
  assert.ok(!text.includes("--minimized"));

  config.writeAutostart(exe, { startMinimized: true });
  text = fs.readFileSync(config.autostartPath(), "utf8");
  assert.match(text, /^Exec=.*--minimized$/m);

  assert.strictEqual(config.removeAutostart(), true);
  assert.strictEqual(fs.existsSync(config.autostartPath()), false);
  assert.strictEqual(config.removeAutostart(), false, "removing twice is not an error");

  assert.throws(() => config.writeAutostart(null), /binary/i);
});

test("applyAutostart follows settings.autostart and never throws", (t) => {
  const env = helpers.useTempEnv();
  const restore = withXdgConfig(path.join(env.root, "config"));
  t.after(() => {
    restore();
    env.cleanup();
  });

  config.save({ autostart: true, startMinimized: true });
  const on = config.applyAutostart(config.load(), "/usr/bin/nx-hub");
  assert.strictEqual(on.enabled, true);
  assert.match(fs.readFileSync(on.path, "utf8"), /Exec=\/usr\/bin\/nx-hub --minimized/);

  config.save({ autostart: false });
  const off = config.applyAutostart(config.load(), "/usr/bin/nx-hub");
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(fs.existsSync(config.autostartPath()), false);

  // no executable path → reported, not thrown
  config.save({ autostart: true });
  const broken = config.applyAutostart(config.load(), null);
  assert.strictEqual(broken.enabled, false);
  assert.ok(broken.error);
});
