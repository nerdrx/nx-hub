// In-page mock of the window.nxhub bridge.
//
// Loaded ONLY when the page is opened outside Electron (window.nxhub missing),
// so the renderer can be screenshotted and driven standalone. Implements the
// full frozen surface with the real app roster from registry/overrides.json,
// animated fake jobs, and a dev toolbar for reaching every UI state.

import { isNewer } from './lib/version.js';

const NOTES_WIVRN = `## WiVRn NX 1.9.2

**Pico standby fix** — the session no longer dies when the headset sleeps.

- automatic bitrate ladder (12–150 Mbit/s), reacts within 2 frames
- OLED-friendly dashboard theme
- fixed \`vk_ext_swapchain\` fallback on Mali drivers

> Requires the matching headset APK — install both sides.

See the [full changelog](https://github.com/nerdrx/wivrn-nx/releases) for details.`;

const NOTES_PULSE = `### PulseNX 2.3.0

1. new OSC batching (halves VRChat packet rate)
2. Discord rich-presence heart glyph
3. watch reconnect backoff

\`\`\`
pulsenx --bridge --osc 127.0.0.1:9000
\`\`\``;

const NOTES_OGB = `### OGB NX-Patches 1.6.0

- **Smooth mutator**: configurable attack/release per contact receiver
- remembers window layout
- fixes a crash when an avatar has 0 receivers`;

const NOTES_HUB = `### NX Hub 0.1.0

First release. Discovers every NX repo, installs, updates, launches.

- self-update from this very card
- tray launcher`;

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

function artifact(a) {
  return {
    id: a.id,
    label: a.label,
    platform: a.platform,
    kind: a.kind,
    assetName: a.assetName || '',
    assetUrl: `https://example.invalid/${a.assetName || 'asset'}`,
    size: a.size || 0,
    packageId: a.packageId || '',
    postInstallNote: a.postInstallNote || '',
    installed: a.installed || null,
    updateAvailable: false,
    // Set when this artifact survived from an older release because the newest
    // one did not ship this platform.
    sourceVersion: a.sourceVersion || '',
    sourceTag: a.sourceTag || '',
    fromOlderRelease: !!a.fromOlderRelease,
    // v0.2
    rollbackAvailable: !!a.rollbackAvailable,
    prevVersion: a.prevVersion || '',
    readyToInstall: !!a.readyToInstall,
  };
}

function baseApps() {
  return [
    {
      id: 'wivrn-nx',
      repo: 'nerdrx/wivrn-nx',
      name: 'WiVRn NX',
      tagline: 'OpenXR streaming to the Pico — NX transport stack',
      private: false,
      order: 1,
      unpublished: false,
      latest: { tag: 'v1.9.2', version: '1.9.2', publishedAt: iso(3), notes: NOTES_WIVRN, prerelease: false },
      artifacts: [
        artifact({
          id: 'apk-adb-android',
          label: 'Pico headset APK',
          platform: 'android',
          kind: 'apk-adb',
          assetName: 'wivrn-nx-release-1.9.2.apk',
          size: 41_500_000,
          packageId: 'org.meumeu.wivrn.nx',
          installed: { version: '1.8.0', path: '', installedAt: iso(21) },
        }),
        artifact({
          id: 'tarball-prefix-linux',
          label: 'Linux server + dashboard',
          platform: 'linux',
          kind: 'tarball-prefix',
          assetName: 'wivrn-nx-server-1.9.2-linux-x86_64.tar.gz',
          size: 18_300_000,
          postInstallNote:
            'Re-run: sudo setcap cap_sys_nice+ep ~/.local/bin/wivrn-server (required after every update)',
          installed: { version: '1.9.2', path: '/home/nerdrx/.local', installedAt: iso(3) },
          // the engine kept the replaced install one level deep
          rollbackAvailable: true,
          prevVersion: '1.9.1',
        }),
      ],
    },
    {
      id: 'wivrn-nx-windows',
      repo: 'nerdrx/wivrn-nx-windows',
      name: 'WiVRn NX for SteamVR',
      tagline: 'Windows port — real SteamVR streamed to the Pico',
      private: true,
      order: 2,
      unpublished: false,
      latest: { tag: 'v0.4.1', version: '0.4.1', publishedAt: iso(9), notes: '', prerelease: true },
      artifacts: [
        artifact({
          id: 'windows-zip-windows',
          label: 'SteamVR driver + helper',
          platform: 'windows',
          kind: 'windows-zip',
          assetName: 'wivrn-nx-windows-0.4.1.zip',
          size: 22_100_000,
        }),
      ],
    },
    {
      id: 'pulsenx',
      repo: 'nerdrx/pulsenx',
      name: 'PulseNX',
      tagline: 'Heart-rate bridge — watch to VRChat, OBS, Discord',
      private: false,
      order: 3,
      unpublished: false,
      latest: { tag: 'v2.3.0', version: '2.3.0', publishedAt: iso(11), notes: NOTES_PULSE, prerelease: false },
      artifacts: [
        artifact({
          id: 'apk-adb-android',
          label: 'Android bridge APK',
          platform: 'android',
          kind: 'apk-adb',
          assetName: 'pulsenx-2.3.0.apk',
          size: 9_800_000,
          packageId: 'com.pulsenx.bridge',
        }),
        // v2.3.0 was an Android-only fix: the PC artifacts survive from v2.2.0
        // and keep their own version, so their rows read against 2.2.0.
        artifact({
          id: 'appimage-linux',
          label: 'PC dashboard (Linux)',
          platform: 'linux',
          kind: 'appimage',
          assetName: 'PulseNX-2.2.0-x86_64.AppImage',
          size: 84_600_000,
          sourceVersion: '2.2.0',
          sourceTag: 'v2.2.0',
          fromOlderRelease: true,
          // iconPath is optional (core records it when it can extract one) —
          // this fake path exercises the <img> path and its monogram fallback.
          installed: {
            version: '2.2.0',
            path: '/home/nerdrx/Applications/nx/pulsenx/appimage-linux',
            iconPath: '/home/nerdrx/Applications/nx/pulsenx/appimage-linux/pulsenx.png',
            installedAt: iso(11),
          },
        }),
        artifact({
          id: 'windows-portable-windows',
          label: 'PC dashboard (Windows)',
          platform: 'windows',
          kind: 'windows-portable',
          assetName: 'PulseNX-2.2.0-windows-portable.exe',
          size: 71_200_000,
          sourceVersion: '2.2.0',
          sourceTag: 'v2.2.0',
          fromOlderRelease: true,
        }),
      ],
    },
    {
      id: 'oscgoesbrrr-nx-patches',
      repo: 'nerdrx/OscGoesBrrr-NX-Patches',
      name: 'OGB NX-Patches',
      tagline: 'OscGoesBrrr with the Smooth mutator',
      private: false,
      order: 4,
      unpublished: false,
      latest: { tag: 'v1.6.0', version: '1.6.0', publishedAt: iso(6), notes: NOTES_OGB, prerelease: false },
      artifacts: [
        artifact({
          id: 'appimage-linux',
          label: 'Linux app',
          platform: 'linux',
          kind: 'appimage',
          assetName: 'OscGoesBrrr-linux-1.6.0.AppImage',
          size: 96_400_000,
          installed: {
            version: '1.4.2',
            path: '/home/nerdrx/Applications/nx/oscgoesbrrr-nx-patches/appimage-linux',
            installedAt: iso(64),
          },
          // downloaded by the background scheduler, waiting for a click
          readyToInstall: true,
        }),
        artifact({
          id: 'windows-portable-windows',
          label: 'Windows portable',
          platform: 'windows',
          kind: 'windows-portable',
          assetName: 'OscGoesBrrr-windows-portable-1.6.0.exe',
          size: 88_900_000,
        }),
      ],
    },
    {
      id: 'quadforge',
      repo: 'nerdrx/quadforge',
      name: 'QuadForge',
      tagline: 'Auto-retopology for Blender',
      private: false,
      order: 5,
      unpublished: false,
      latest: { tag: 'v0.9.0', version: '0.9.0', publishedAt: iso(19), notes: '- quad flow solver\n- Blender 5.2 support', prerelease: false },
      artifacts: [
        artifact({
          id: 'blender-addon-linux',
          label: 'Blender addon',
          platform: 'linux',
          kind: 'blender-addon',
          assetName: 'quadforge-0.9.0.zip',
          size: 1_240_000,
        }),
      ],
    },
    {
      id: 'banish-protocol',
      repo: 'nerdrx/banish-protocol',
      name: 'LIMBO PROTOCOL',
      tagline: 'Co-op roguelite — invade a rogue AI',
      private: true,
      order: 6,
      unpublished: false,
      latest: { tag: 'v0.2.0-alpha', version: '0.2.0-alpha', publishedAt: iso(41), notes: '', prerelease: true },
      artifacts: [
        artifact({
          id: 'archive-dir-linux',
          label: 'Linux build',
          platform: 'linux',
          kind: 'archive-dir',
          assetName: 'limbo-protocol-linux-0.2.0.zip',
          size: 412_000_000,
        }),
        artifact({
          id: 'windows-zip-windows',
          label: 'Windows build',
          platform: 'windows',
          kind: 'windows-zip',
          assetName: 'limbo-protocol-windows-0.2.0.zip',
          size: 428_000_000,
        }),
      ],
    },
    {
      id: 'wivrn',
      repo: 'WiVRn/WiVRn',
      name: 'WiVRn (upstream)',
      tagline: 'Pinned via Sources — upstream OpenXR streamer',
      private: false,
      order: 100,
      unpublished: false,
      latest: { tag: 'v0.9.1', version: '0.9.1', publishedAt: iso(27), notes: '', prerelease: false },
      artifacts: [
        artifact({
          id: 'appimage-linux',
          label: 'Linux server',
          platform: 'linux',
          kind: 'appimage',
          assetName: 'WiVRn-x86_64.AppImage',
          size: 64_000_000,
        }),
      ],
    },
    {
      id: 'nx-hub',
      repo: 'nerdrx/nx-hub',
      name: 'NX Hub',
      tagline: 'This launcher — installs and updates itself',
      private: false,
      order: 90,
      unpublished: false,
      latest: { tag: 'v0.1.0', version: '0.1.0', publishedAt: iso(1), notes: NOTES_HUB, prerelease: false },
      artifacts: [
        artifact({
          id: 'appimage-linux',
          label: 'NX Hub (Linux)',
          platform: 'linux',
          kind: 'appimage',
          assetName: 'NX-Hub-0.1.0-linux.AppImage',
          size: 102_000_000,
          installed: { version: '0.1.0', path: '/home/nerdrx/Applications/nx/nx-hub/appimage-linux', installedAt: iso(1) },
        }),
      ],
    },
    {
      id: 'nxtakt',
      repo: 'nerdrx/nxtakt',
      name: 'NxTakt',
      tagline: 'Session-first native DAW for Linux',
      private: false,
      order: 7,
      unpublished: true,
      latest: null,
      artifacts: [],
    },
    {
      id: 'lattice-notes',
      repo: 'nerdrx/lattice-notes',
      name: 'lattice-notes',
      tagline: 'Scratch repo — no releases',
      private: true,
      order: 100,
      unpublished: true,
      latest: null,
      artifacts: [],
    },
  ];
}

function recompute(apps, settings) {
  const prefs = (settings && settings.appPrefs) || {};
  for (const app of apps) {
    const latest = app.latest && app.latest.version;
    for (const a of app.artifacts) {
      // An artifact carried over from an older release is compared against the
      // version that actually shipped it, like main does.
      const target = a.sourceVersion || latest;
      a.updateAvailable = !!(a.installed && target && isNewer(target, a.installed.version));
      if (!a.updateAvailable) a.readyToInstall = false;
    }
    // main mirrors the per-app "hidden" pref onto the app model
    app.localHidden = !!(prefs[app.id] && prefs[app.id].hidden);
  }
  return apps;
}

/** Older versions of a semver-ish string: 1.9.2 → 1.9.1, 1.9.0, 1.8.3, … */
function olderVersions(version, count) {
  const parts = String(version).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  let [maj, min, pat] = [parts[0] || 1, parts[1] || 0, parts[2] || 0];
  const out = [];
  for (let i = 0; i < count; i++) {
    if (pat > 0) pat -= 1;
    else if (min > 0) {
      min -= 1;
      pat = 3;
    } else if (maj > 0) {
      maj -= 1;
      min = 9;
      pat = 0;
    }
    out.push(`${maj}.${min}.${pat}`);
  }
  return out;
}

const OLD_NOTES = [
  '- stability pass on the reconnect path\n- fixed a leak in the encoder queue',
  '### Maintenance\n\n- dependency bump\n- clearer error when the device disappears mid-install',
  '- first build of this line\n- known issue: the dashboard forgets its window size',
];

/**
 * A believable release history for one app: the current release, an unreleased
 * pre-release above it (so the pre-release chip is reachable), and four older
 * tags whose assets carry the matching version in their names.
 */
function fakeHistory(app) {
  const latest = app.latest;
  if (!latest) return [];
  const assetsFor = (version) =>
    (app.artifacts || []).map((a) => ({
      name: String(a.assetName || '').replace(latest.version, version),
      size: a.size,
    }));

  const head = {
    tag: latest.tag,
    version: latest.version,
    notes: latest.notes,
    publishedAt: latest.publishedAt,
    prerelease: !!latest.prerelease,
    assets: assetsFor(latest.version),
  };

  const older = olderVersions(latest.version, 4).map((v, i) => ({
    tag: `v${v}`,
    version: v,
    notes: OLD_NOTES[i % OLD_NOTES.length],
    publishedAt: iso(20 + i * 17),
    prerelease: false,
    assets: assetsFor(v),
  }));

  const releases = [head, ...older];
  if (!latest.prerelease) {
    const bits = latest.version.split('.').map((n) => parseInt(n, 10) || 0);
    const next = `${bits[0] || 1}.${(bits[1] || 0) + 1}.0-rc1`;
    releases.unshift({
      tag: `v${next}`,
      version: next,
      notes: '**Release candidate** — testing the new pipeline. Not for daily use.',
      publishedAt: iso(1),
      prerelease: true,
      assets: assetsFor(next),
    });
  }
  return releases;
}

export function createMock() {
  const listeners = new Set();
  const timers = new Set();
  let jobSeq = 0;

  const settings = {
    owners: ['nerdrx'],
    extraRepos: ['WiVRn/WiVRn'],
    token: '',
    checkIntervalHours: 6,
    installRoot: '~/Applications',
    adbPath: 'adb',
    // v0.2
    appPrefs: {
      pulsenx: { favorite: true, updatePolicy: 'install' },
      'wivrn-nx': {
        updatePolicy: 'download',
        launchArgs: ['--profile', 'living room'],
        launchEnv: { WIVRN_BITRATE: '80000000' },
      },
      wivrn: { hidden: true },
      // strict mode: only artifacts from the newest release are offered
      quadforge: { skippedVersion: '0.9.0', releaseFallback: false },
    },
    updatePolicy: 'notify',
    includePrereleases: false,
    notifications: true,
    autostart: false,
    startMinimized: false,
    createDesktopEntries: true,
    maxConcurrentDownloads: 2,
    preferredDeviceSerial: 'PA7HA0M123',
  };

  const state = {
    apps: recompute(baseApps(), settings),
    settings,
    jobs: [],
    adb: {
      connected: true,
      devices: [{ serial: 'PA7HA0M123', model: 'Pico 4 Ultra', state: 'device' }],
      versions: { 'org.meumeu.wivrn.nx': '1.8.0' },
    },
    hubVersion: '0.1.0',
    refreshing: false,
    platform: 'linux',
    tokenSource: 'gh',
    hasToken: true,
    rateLimit: null,
  };

  // Storage, device facts and the log tail live outside `state` — they are
  // pulled on demand through their own bridge methods.
  const disk = {
    perApp: {
      'wivrn-nx': 486_000_000,
      pulsenx: 212_400_000,
      'oscgoesbrrr-nx-patches': 331_900_000,
      'nx-hub': 174_300_000,
    },
    downloads: 903_500_000,
  };
  let device = {
    serial: 'PA7HA0M123',
    model: 'Pico 4 Ultra',
    batteryPct: 82,
    storageFreeBytes: 13_300_000_000,
  };
  const releases = new Map();

  const emit = (ev) => {
    for (const cb of [...listeners]) {
      try {
        cb(ev);
      } catch {
        /* a bad listener must not break the mock */
      }
    }
  };
  const changed = () => emit({ type: 'state-changed' });
  // The mock also runs under `node --test` (no window) — fall back to the
  // global timers there so the async paths stay testable.
  const host = typeof window !== 'undefined' ? window : globalThis;
  const later = (fn, ms) => {
    const t = host.setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };

  function find(appId, artifactId) {
    const app = state.apps.find((a) => a.id === appId);
    if (!app) return {};
    return { app, art: app.artifacts.find((a) => a.id === artifactId) };
  }

  function runJob(appId, artifactId, { fail = false, target = '' } = {}) {
    const { app, art } = find(appId, artifactId);
    if (!app || !art) return null;
    const jobId = `job-${++jobSeq}`;
    const job = { id: jobId, appId, artifactId, phase: 'download', pct: 0, message: '' };
    state.jobs = [...state.jobs.filter((j) => j.appId !== appId), job];
    changed();

    const phases = [
      { phase: 'download', to: 100, step: 7 },
      { phase: 'verify', to: 100, step: 34 },
      { phase: 'extract', to: 100, step: 25 },
      { phase: 'install', to: 100, step: 50 },
      { phase: 'cleanup', to: 100, step: 100 },
    ];
    let pi = 0;
    let pct = 0;

    const tick = () => {
      if (!state.jobs.some((j) => j.id === jobId)) return; // cancelled
      const p = phases[pi];
      pct = Math.min(p.to, pct + p.step + Math.random() * 4);
      const speed = (8 + Math.random() * 9).toFixed(1);
      job.phase = p.phase;
      job.pct = Math.round(pct);
      job.message = p.phase === 'download' ? `${speed} MB/s` : '';
      emit({
        type: 'job-progress',
        jobId,
        appId,
        artifactId,
        phase: job.phase,
        pct: job.pct,
        message: job.message,
      });

      if (fail && p.phase === 'verify') {
        state.jobs = state.jobs.filter((j) => j.id !== jobId);
        emit({
          type: 'job-error',
          jobId,
          appId,
          artifactId,
          message: `checksum mismatch for ${art.assetName}`,
        });
        changed();
        return;
      }

      if (pct >= p.to) {
        pi += 1;
        pct = 0;
        if (pi >= phases.length) {
          state.jobs = state.jobs.filter((j) => j.id !== jobId);
          const version = target || (app.latest && app.latest.version) || '1.0.0';
          const replaced = art.installed && art.installed.version;
          art.installed = {
            version,
            path: `/home/nerdrx/Applications/nx/${app.id}/${art.id}`,
            installedAt: new Date().toISOString(),
          };
          // engines keep the replaced install one level deep → rollback target
          if (replaced && replaced !== version) {
            art.prevVersion = replaced;
            art.rollbackAvailable = true;
          }
          art.readyToInstall = false;
          // Core may or may not extract an icon; the launcher tolerates both.
          if (art.kind === 'apk-adb' && art.packageId) state.adb.versions[art.packageId] = version;
          recompute(state.apps, state.settings);
          emit({ type: 'job-done', jobId, appId, artifactId });
          emit({ type: 'toast', level: 'info', message: `${app.name} — ${art.label} installed (${version})` });
          changed();
          return;
        }
      }
      later(tick, 140);
    };
    later(tick, 120);
    return jobId;
  }

  // ?slow=1 delays the very first getState so the loading skeletons are
  // screenshottable; ?notoken=1 opens on the "private repos hidden" hint.
  const search = typeof location !== 'undefined' ? String(location.search || '') : '';
  let firstState = true;
  if (/[?&]notoken\b/.test(search)) {
    state.tokenSource = '';
    state.hasToken = false;
  }

  const nxhub = {
    async getState() {
      if (firstState && /[?&]slow\b/.test(search)) {
        firstState = false;
        await new Promise((r) => later(r, 2500));
      }
      firstState = false;
      return JSON.parse(JSON.stringify(state));
    },
    async refresh(force) {
      state.refreshing = true;
      changed();
      later(() => {
        state.refreshing = false;
        changed();
        emit({
          type: 'toast',
          level: 'info',
          message: `Discovery finished — ${state.apps.length} repositories${force ? ' (cache bypassed)' : ''}`,
        });
      }, 900);
      return true;
    },
    async install(appId, artifactId) {
      return runJob(appId, artifactId);
    },
    async uninstall(appId, artifactId) {
      const { app, art } = find(appId, artifactId);
      if (!art) return false;
      art.installed = null;
      recompute(state.apps, state.settings);
      changed();
      emit({ type: 'toast', level: 'info', message: `${app.name} — ${art.label} removed` });
      return true;
    },
    async launch(appId, artifactId) {
      const { app, art } = find(appId, artifactId);
      emit({
        type: 'toast',
        level: 'info',
        message: art ? `Launching ${app.name} — ${art.label}…` : `Cannot launch ${appId}`,
      });
      return true;
    },
    async cancelJob(jobId) {
      const job = state.jobs.find((j) => j.id === jobId);
      state.jobs = state.jobs.filter((j) => j.id !== jobId);
      changed();
      emit({ type: 'toast', level: 'warn', message: `Job cancelled${job ? ` (${job.appId})` : ''}` });
      return true;
    },
    async setSettings(patch) {
      Object.assign(state.settings, patch || {});
      // Clearing the token in the mock also drops the gh-CLI fallback so the
      // "private repos are hidden" hint state is reachable for screenshots.
      state.tokenSource = state.settings.token ? 'settings' : '';
      state.hasToken = !!state.settings.token;
      changed();
      return true;
    },
    async openExternal(url) {
      emit({ type: 'toast', level: 'info', message: `Would open ${url}` });
      return true;
    },
    async showInFolder(path) {
      emit({ type: 'toast', level: 'info', message: `Would reveal ${path}` });
      return true;
    },
    onEvent(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /* --------------------------------------------------------- v0.2 surface */

    async getReleases(appId) {
      const app = state.apps.find((a) => a.id === appId);
      if (!app) return [];
      if (!releases.has(appId)) releases.set(appId, fakeHistory(app));
      // a small delay so the sheet's loading state is reachable
      await new Promise((r) => later(r, 260));
      return JSON.parse(JSON.stringify(releases.get(appId)));
    },
    async installVersion(appId, artifactId, tag) {
      const app = state.apps.find((a) => a.id === appId);
      const list = (app && releases.get(appId)) || fakeHistory(app || {});
      const rel = list.find((r) => r.tag === tag);
      return runJob(appId, artifactId, { target: (rel && rel.version) || String(tag || '').replace(/^v/, '') });
    },
    async rollback(appId, artifactId) {
      const { app, art } = find(appId, artifactId);
      if (!art || !art.rollbackAvailable || !art.prevVersion) return false;
      const from = art.installed ? art.installed.version : '';
      art.installed = { ...(art.installed || {}), version: art.prevVersion, installedAt: new Date().toISOString() };
      art.rollbackAvailable = false;
      art.prevVersion = '';
      if (art.kind === 'apk-adb' && art.packageId) state.adb.versions[art.packageId] = art.installed.version;
      recompute(state.apps, state.settings);
      changed();
      emit({
        type: 'toast',
        level: 'info',
        message: `${app.name} — ${art.label} rolled back${from ? ` from ${from}` : ''} to ${art.installed.version}`,
      });
      return true;
    },
    async setAppPref(appId, patch) {
      if (!appId) return false;
      const prefs = state.settings.appPrefs || (state.settings.appPrefs = {});
      prefs[appId] = { ...(prefs[appId] || {}), ...(patch || {}) };
      recompute(state.apps, state.settings);
      changed();
      return true;
    },
    async adbConnect(hostPort) {
      await new Promise((r) => later(r, 700));
      if (/^(?:0\.0\.0\.0|127\.0\.0\.1|localhost)\b/.test(String(hostPort || ''))) {
        return { ok: false, error: `failed to connect to ${hostPort}: connection refused` };
      }
      const serial = String(hostPort);
      if (!state.adb.devices.some((d) => d.serial === serial)) {
        state.adb.devices.push({ serial, model: 'Pico 4 (wireless)', state: 'device' });
      }
      state.adb.connected = true;
      device = { ...device, serial, model: 'Pico 4 (wireless)' };
      changed();
      emit({ type: 'toast', level: 'info', message: `Connected to ${serial}` });
      return { ok: true, serial };
    },
    async adbSelectDevice(serial) {
      state.settings.preferredDeviceSerial = String(serial || '');
      const picked = state.adb.devices.find((d) => d.serial === serial);
      if (picked) device = { ...device, serial: picked.serial, model: picked.model };
      changed();
      return true;
    },
    async getDeviceInfo() {
      if (!state.adb.connected || !state.adb.devices.length) return null;
      await new Promise((r) => later(r, 180));
      return { ...device };
    },
    async getDiskUsage() {
      await new Promise((r) => later(r, 320));
      const perApp = {};
      for (const [id, bytes] of Object.entries(disk.perApp)) {
        const app = state.apps.find((a) => a.id === id);
        if (app && app.artifacts.some((a) => a.installed)) perApp[id] = bytes;
      }
      const total = Object.values(perApp).reduce((a, b) => a + b, 0) + disk.downloads;
      return { perApp, downloads: disk.downloads, total };
    },
    async clearDownloadCache() {
      const freed = disk.downloads;
      disk.downloads = 0;
      changed();
      return { ok: true, freed };
    },
    async getLogs(tailLines) {
      const n = Math.max(1, Math.min(2000, Number(tailLines) || 200));
      const lines = [];
      const phases = [
        'discovery: 10 repositories, 8 with releases',
        'github: 304 Not Modified for nerdrx/pulsenx',
        'jobs: install wivrn-nx/apk-adb-android queued',
        'adb: device PA7HA0M123 online (Pico 4 Ultra)',
        'install: extracted squashfs-root without libfuse2',
        'state: wrote ~/.local/share/nx-hub/state.json',
        'scheduler: next check in 6h (policy notify)',
      ];
      for (let i = n; i > 0; i--) {
        const t = new Date(Date.now() - i * 45_000).toISOString().replace('T', ' ').slice(0, 19);
        lines.push(`${t}  ${phases[i % phases.length]}`);
      }
      return lines.join('\n');
    },
    async exportSettings() {
      return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), settings: state.settings }, null, 2);
    },
    async importSettings(json) {
      try {
        const parsed = typeof json === 'string' ? JSON.parse(json) : json;
        const incoming = (parsed && parsed.settings) || parsed;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
          return { ok: false, error: 'That file does not look like an NX Hub export.' };
        }
        const keys = Object.keys(incoming);
        Object.assign(state.settings, incoming);
        recompute(state.apps, state.settings);
        changed();
        return {
          ok: true,
          imported: keys.length,
          warnings: keys.includes('token') ? ['The token from the file replaced the current one.'] : [],
        };
      } catch (err) {
        return { ok: false, error: `Could not parse the file: ${(err && err.message) || err}` };
      }
    },
  };

  // ------------------------------------------------------------ dev helpers
  const dev = {
    state,
    emit,
    simulateUpdate() {
      const bump = (v) => {
        const parts = String(v).split('.');
        parts[1] = String((Number(parts[1]) || 0) + 1);
        parts[2] = '0';
        return parts.join('.');
      };
      for (const app of state.apps) {
        if (!app.latest) continue;
        if (!app.artifacts.some((a) => a.installed)) continue;
        app.latest.version = bump(app.latest.version);
        app.latest.tag = `v${app.latest.version}`;
        app.latest.publishedAt = new Date().toISOString();
      }
      recompute(state.apps, state.settings);
      changed();
      emit({ type: 'toast', level: 'info', message: 'New releases found for 4 apps' });
    },
    simulateJob() {
      runJob('quadforge', 'blender-addon-linux');
    },
    simulateError() {
      emit({
        type: 'toast',
        level: 'error',
        message: 'GitHub API rate limit exceeded for 84.x.x.x — add a token in settings',
      });
      runJob('banish-protocol', 'archive-dir-linux', { fail: true });
    },
    toggleAdb() {
      state.adb.connected = !state.adb.connected;
      state.adb.devices = state.adb.connected
        ? [{ serial: 'PA7HA0M123', model: 'Pico 4 Ultra', state: 'device' }]
        : [];
      changed();
      emit({
        type: 'toast',
        level: state.adb.connected ? 'info' : 'warn',
        message: state.adb.connected ? 'Pico 4 Ultra connected' : 'Headset disconnected',
      });
    },

    /* -------------------------------------------------------- v0.2 helpers */

    /** Fire the update-available event (toast with an Update button + badge). */
    simulateUpdateEvent(appId) {
      const app =
        state.apps.find((a) => a.id === appId) ||
        state.apps.find((a) => a.id === 'pulsenx') ||
        state.apps.find((a) => a.artifacts.some((x) => x.installed));
      if (!app || !app.latest) return null;
      const bits = String(app.latest.version).split('.');
      bits[bits.length - 1] = String((Number(bits[bits.length - 1]) || 0) + 1);
      app.latest.version = bits.join('.');
      app.latest.tag = `v${app.latest.version}`;
      app.latest.publishedAt = new Date().toISOString();
      // The simulated release ships every platform, so nothing rides on an
      // older release any more.
      for (const a of app.artifacts) {
        a.sourceVersion = '';
        a.sourceTag = '';
        a.fromOlderRelease = false;
      }
      releases.delete(app.id);
      recompute(state.apps, state.settings);
      changed();
      emit({ type: 'update-available', appId: app.id, version: app.latest.version });
      return app.id;
    },
    /** Re-roll the per-app storage numbers so the bars visibly change. */
    populateDisk() {
      const jitter = (n) => Math.round(n * (0.55 + Math.random() * 1.1));
      for (const id of Object.keys(disk.perApp)) disk.perApp[id] = jitter(disk.perApp[id]);
      for (const app of state.apps) {
        if (app.artifacts.some((a) => a.installed) && !disk.perApp[app.id]) {
          disk.perApp[app.id] = jitter(120_000_000);
        }
      }
      disk.downloads = jitter(900_000_000);
      emit({ type: 'toast', level: 'info', message: 'Disk usage re-measured' });
      changed();
      return disk;
    },
    /** Cycle the fake device facts (healthy → low battery → nearly full). */
    fakeDeviceInfo() {
      const cycle = [
        { model: 'Pico 4 Ultra', batteryPct: 82, storageFreeBytes: 13_300_000_000 },
        { model: 'Pico 4 Ultra', batteryPct: 17, storageFreeBytes: 2_100_000_000 },
        { model: 'Quest 3', batteryPct: 46, storageFreeBytes: 48_900_000_000 },
      ];
      const i = cycle.findIndex((c) => c.batteryPct === device.batteryPct);
      const next = cycle[(i + 1) % cycle.length];
      device = { ...device, ...next };
      if (!state.adb.connected) {
        state.adb.connected = true;
        state.adb.devices = [{ serial: device.serial, model: next.model, state: 'device' }];
      } else {
        state.adb.devices = state.adb.devices.map((d) =>
          d.serial === device.serial ? { ...d, model: next.model } : d
        );
      }
      changed();
      emit({ type: 'toast', level: 'info', message: `Device now ${next.model} · ${next.batteryPct}%` });
      return { ...device };
    },
    /** Stage a downloaded-but-unapplied update on every updatable artifact. */
    stageDownloads() {
      let n = 0;
      for (const app of state.apps) {
        for (const art of app.artifacts) {
          if (art.updateAvailable) {
            art.readyToInstall = true;
            n++;
          }
        }
      }
      changed();
      emit({ type: 'toast', level: 'info', message: `${n} update${n === 1 ? '' : 's'} downloaded and ready` });
      return n;
    },
    stop() {
      for (const t of timers) host.clearTimeout(t);
      timers.clear();
    },
  };

  return { nxhub, dev };
}

function toolbar(dev) {
  const bar = document.createElement('div');
  bar.className = 'mock-bar';
  bar.innerHTML = `
    <span class="tag">mock</span>
    <button class="btn btn-ghost btn-sm" data-mock="update">simulate update available</button>
    <button class="btn btn-ghost btn-sm" data-mock="update-event">simulate update-available event</button>
    <button class="btn btn-ghost btn-sm" data-mock="staged">stage downloaded updates</button>
    <button class="btn btn-ghost btn-sm" data-mock="job">simulate install job</button>
    <button class="btn btn-ghost btn-sm" data-mock="error">simulate error toast</button>
    <button class="btn btn-ghost btn-sm" data-mock="adb">toggle adb device</button>
    <button class="btn btn-ghost btn-sm" data-mock="device">fake device info</button>
    <button class="btn btn-ghost btn-sm" data-mock="disk">populate disk usage</button>`;
  bar.addEventListener('click', (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest('[data-mock]') : null;
    if (!el) return;
    const what = el.getAttribute('data-mock');
    if (what === 'update') dev.simulateUpdate();
    else if (what === 'update-event') dev.simulateUpdateEvent();
    else if (what === 'staged') dev.stageDownloads();
    else if (what === 'job') dev.simulateJob();
    else if (what === 'error') dev.simulateError();
    else if (what === 'adb') dev.toggleAdb();
    else if (what === 'device') dev.fakeDeviceInfo();
    else if (what === 'disk') dev.populateDisk();
  });
  document.body.appendChild(bar);
}

/** Install the mock bridge + dev toolbar. Safe to call once. */
export function installMock() {
  if (typeof window === 'undefined' || window.nxhub) return null;
  const { nxhub, dev } = createMock();
  window.nxhub = nxhub;
  window.__nxhubMock = dev;
  if (typeof document !== 'undefined' && document.body) toolbar(dev);
  return dev;
}
