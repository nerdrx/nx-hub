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
    // v0.6 — crash-aware rollback
    crashCount: a.crashCount || 0,
    crashLoop: !!a.crashLoop,
    lastCrashAt: a.lastCrashAt || '',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mb(bytes) {
  return `${Math.max(0.1, bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The progress messages a delta update produces, in [resilience]'s own words.
 * The patch is a fifth of the full asset — that ratio is what the Δ chip and
 * the closing line are advertising.
 */
function deltaMessage(phase, art, pct) {
  const full = art.size || 90_000_000;
  const patch = Math.round(full * 0.19);
  const from = (art.installed && art.installed.version) || 'the installed build';
  if (phase === 'download') {
    return pct < 30
      ? `downloading delta patch (${mb(patch)} instead of ${mb(full)})`
      : `delta patch — ${mb((patch * pct) / 100)} / ${mb(patch)}`;
  }
  if (phase === 'extract') return `applying delta patch (zstd, from ${from})`;
  if (phase === 'verify') return 'verifying the delta result';
  if (phase === 'cleanup') {
    return `delta applied — ${mb(patch)} downloaded instead of ${mb(full)} (${Math.round(
      (1 - patch / full) * 100
    )}% saved)`;
  }
  return '';
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
      // The overlay describes one of the two fields this app streams — the
      // other one has to render generically, which is the interesting case.
      connectorFields: [{ key: 'bitrate', label: 'Bitrate', unit: 'Mbit/s', kind: 'number' }],
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
      connectorFields: [
        { key: 'hr', label: 'Heart rate', unit: 'bpm', kind: 'number' },
        { key: 'connected', label: 'Watch', kind: 'bool' },
      ],
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
          // v0.6 — this one keeps dying seconds after launch, and the engine
          // kept the version it replaced, so the banner can offer a way back.
          crashCount: 4,
          crashLoop: true,
          lastCrashAt: new Date(Date.now() - 4 * 60000).toISOString(),
          rollbackAvailable: true,
          prevVersion: '1.4.1',
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
        // v0.6 — this one's setcap line runs itself; the global default is off.
        autoRunCmd: true,
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
    // v0.6 — global auto-run stays off; wivrn-nx opts in per app.
    autoRunPostInstallCmd: false,
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
    // v0.5 — the connector bus roster. Two apps are announced from the start so
    // the live strip, the tile dot and the tray line all have something to say.
    connector: {
      clients: [
        {
          app: 'pulsenx',
          version: '2.2.0',
          pid: 40211,
          since: new Date(Date.now() - 26 * 60000).toISOString(),
          lastSeen: new Date().toISOString(),
          fields: { hr: 72, connected: true },
        },
        {
          app: 'wivrn-nx',
          version: '1.9.2',
          pid: 40877,
          since: new Date(Date.now() - 8 * 60000).toISOString(),
          lastSeen: new Date().toISOString(),
          fields: { bitrate: 98, latency_ms: 43 },
        },
      ],
    },
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

  function runJob(appId, artifactId, { fail = false, target = '', delta = false } = {}) {
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
      // A delta update speaks [resilience]'s exact vocabulary — the renderer
      // matches "delta patch"/"delta applied", never the bare word (asset names
      // contain it).
      job.message = delta ? deltaMessage(p.phase, art, job.pct) : p.phase === 'download' ? `${speed} MB/s` : '';
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
          // SPEC v0.6: the crash counter belongs to a version — new bytes, fresh
          // start, and the card's banner re-arms with them.
          art.crashCount = 0;
          art.crashLoop = false;
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

  /* ------------------------------------------------------ connector + stacks */

  const busChanged = () => emit({ type: 'connector-changed' });

  function clientIndex(appId) {
    return state.connector.clients.findIndex((c) => c.app === appId);
  }

  function fieldsFor(appId) {
    if (appId === 'pulsenx') return { hr: 72, connected: true };
    if (appId === 'wivrn-nx') return { bitrate: 98, latency_ms: 43 };
    if (appId === 'oscgoesbrrr-nx-patches') return { receivers: 14, smoothing: true };
    return { state: 'running' };
  }

  function addClient(appId) {
    if (!appId || clientIndex(appId) >= 0) return false;
    const app = state.apps.find((a) => a.id === appId);
    const art = app && app.artifacts.find((a) => a.installed);
    state.connector.clients.push({
      app: appId,
      version: (art && art.installed.version) || (app && app.latest && app.latest.version) || '',
      pid: 40000 + Math.floor(Math.random() * 9000),
      since: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      fields: fieldsFor(appId),
    });
    busChanged();
    return true;
  }

  function dropClient(appId) {
    const i = clientIndex(appId);
    if (i < 0) return false;
    state.connector.clients.splice(i, 1);
    busChanged();
    return true;
  }

  // Live values drift the way a real app's status would.
  const jitter = (v, lo, hi, spread) =>
    Math.max(lo, Math.min(hi, Math.round(v + (Math.random() - 0.5) * spread)));

  // Started by installMock(), never by createMock(): a self-rescheduling timer
  // would keep a `node --test` process alive forever.
  let ticking = false;
  function tickFields() {
    for (const client of state.connector.clients) {
      const f = client.fields;
      if (typeof f.hr === 'number') f.hr = jitter(f.hr, 52, 148, 9);
      if (typeof f.bitrate === 'number') f.bitrate = jitter(f.bitrate, 12, 150, 22);
      if (typeof f.latency_ms === 'number') f.latency_ms = jitter(f.latency_ms, 14, 120, 12);
      if (typeof f.receivers === 'number') f.receivers = jitter(f.receivers, 0, 40, 3);
      client.lastSeen = new Date().toISOString();
    }
    if (state.connector.clients.length) busChanged();
    if (ticking) later(tickFields, 2400);
  }

  let stacks = [
    {
      id: 'vr-night',
      name: 'VR Night',
      steps: [
        {
          appId: 'wivrn-nx',
          artifactId: 'tarball-prefix-linux',
          health: { type: 'connector', timeoutMs: 30000 },
        },
        {
          appId: 'oscgoesbrrr-nx-patches',
          artifactId: 'appimage-linux',
          health: { type: 'delay', timeoutMs: 1500 },
          optional: true,
        },
        { appId: 'pulsenx', artifactId: 'appimage-linux', health: { type: 'connector', timeoutMs: 20000 } },
      ],
    },
    // v0.6 — a stack that starts itself the moment the headset shows up.
    {
      id: 'headset-arrives',
      name: 'Headset arrives',
      trigger: {
        type: 'adb-device',
        serial: 'PA7HA0M123',
        stopOnLeave: true,
        cooldownMs: 90000,
      },
      steps: [
        { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', health: { type: 'connector', timeoutMs: 30000 } },
        { appId: 'pulsenx', artifactId: 'appimage-linux', health: { type: 'delay', timeoutMs: 1200 }, optional: true },
      ],
    },
  ];

  // Every run walks a different path so the UI can reach all of its states:
  // 0 = everything comes up · 1 = the optional step times out and the run
  // carries on · 2 = a required step times out and the run stops there.
  let runMode = 0;
  const runs = new Map(); // stackId → token

  function progress(stackId, stepIndex, appId, phase) {
    emit({ type: 'stack-progress', stackId, stepIndex, appId, phase });
  }

  function runStackSim(stackId) {
    const stack = stacks.find((s) => s.id === stackId);
    if (!stack || !stack.steps.length || runs.has(stackId)) return false;
    const token = { stopped: false, index: 0, mode: runMode % 3, added: [] };
    runMode += 1;
    runs.set(stackId, token);

    const step = () => {
      if (token.stopped) return;
      if (token.index >= stack.steps.length) {
        progress(stackId, stack.steps.length - 1, '', 'done');
        runs.delete(stackId);
        emit({ type: 'toast', level: 'info', message: `${stack.name} is up` });
        return;
      }
      const i = token.index;
      const s = stack.steps[i];
      const fails =
        (token.mode === 1 && !!s.optional) || (token.mode === 2 && i === stack.steps.length - 1);

      progress(stackId, i, s.appId, 'launching');
      later(() => {
        if (token.stopped) return;
        progress(stackId, i, s.appId, 'waiting');
        later(() => {
          if (token.stopped) return;
          if (fails) {
            progress(stackId, i, s.appId, 'failed');
            if (!s.optional) {
              runs.delete(stackId);
              emit({
                type: 'toast',
                level: 'error',
                message: `${stack.name}: ${s.appId} never came up — the run stopped`,
              });
              return;
            }
          } else {
            if (s.health.type === 'connector' && addClient(s.appId)) token.added.push(s.appId);
            progress(stackId, i, s.appId, 'healthy');
          }
          token.index = i + 1;
          later(step, 160);
        }, 300);
      }, 220);
    };
    later(step, 120);
    return true;
  }

  function stopStackSim(stackId) {
    const stack = stacks.find((s) => s.id === stackId);
    if (!stack) return false;
    const token = runs.get(stackId) || null;
    if (token) token.stopped = true;
    const at = token ? Math.min(token.index, stack.steps.length - 1) : stack.steps.length - 1;
    progress(stackId, at, stack.steps[at] ? stack.steps[at].appId : '', 'stopping');
    later(() => {
      // Reverse order, the way main takes a stack down: every app in the stack
      // gets a shutdown-request, not just the ones this run happened to start.
      for (const step of [...stack.steps].reverse()) dropClient(step.appId);
      progress(stackId, 0, stack.steps[0] ? stack.steps[0].appId : '', 'stopped');
      runs.delete(stackId);
    }, 380);
    return true;
  }

  /* ------------------------------------------------------------------ fleet */

  // The code the fake "other hub" is willing to accept. Anything else takes the
  // wrong-code path, which is the interesting one to design against.
  const PAIR_CODE = '482913';
  const PAIR_WINDOW_MS = 120000;
  let pairWindow = null; // { code, expiresAt } while this hub is showing one

  let peers = [
    {
      id: 'a1b2c3d4e5f60718',
      name: 'workshop-pc',
      host: '192.168.1.50',
      hubVersion: '0.6.0',
      online: true,
      lastSeen: new Date().toISOString(),
      summary: {
        apps: [
          { id: 'wivrn-nx', name: 'WiVRn NX', installed: '1.9.0', updates: 1 },
          { id: 'pulsenx', name: 'PulseNX', installed: '2.3.0', updates: 0 },
          { id: 'oscgoesbrrr-nx-patches', name: 'OGB NX-Patches', installed: '', updates: 0 },
          // An app this hub has never discovered — its row still works, and the
          // quotes and ampersand prove the escaping on a real screen.
          { id: 'lab-rig', name: 'Lab Rig "beta" & co', installed: '0.4.0', updates: 2 },
        ],
      },
    },
    {
      id: '99887766554433aa',
      name: 'living-room',
      host: 'living-room.local',
      hubVersion: '0.5.0',
      online: false,
      lastSeen: new Date(Date.now() - 41 * 60000).toISOString(),
      summary: {
        apps: [
          { id: 'wivrn-nx', name: 'WiVRn NX', installed: '1.8.0', updates: 1 },
          { id: 'pulsenx', name: 'PulseNX', installed: '', updates: 0 },
        ],
      },
    },
  ];

  const fleetChanged = () => emit({ type: 'fleet-changed' });
  const findPeer = (id) => peers.find((p) => p.id === id) || null;

  function remoteApp(peerId, appId) {
    const p = findPeer(peerId);
    return (p && p.summary.apps.find((a) => a.id === appId)) || null;
  }

  /** Relay a fake remote job: the same phases, tagged with the peer. */
  function fleetJobSim(peerId, appId, artifactId, opts = {}) {
    const p = findPeer(peerId);
    if (!p) return null;
    const jobId = `remote-${++jobSeq}`;
    const phases = ['download', 'verify', 'extract', 'install'];
    let i = 0;
    let pct = 0;
    const delta = !!opts.delta;

    const tick = () => {
      pct += 32 + Math.random() * 14;
      if (pct >= 100) {
        pct = 0;
        i += 1;
      }
      if (i >= phases.length) {
        emit({ type: 'fleet-progress', peerId, jobId, appId, artifactId, phase: 'done', pct: 100, message: '' });
        const row = remoteApp(peerId, appId);
        if (row && opts.version) {
          row.installed = opts.version;
          row.updates = 0;
        }
        p.lastSeen = new Date().toISOString();
        fleetChanged();
        emit({ type: 'toast', level: 'info', message: `${p.name}: ${appId} is up to date` });
        return;
      }
      emit({
        type: 'fleet-progress',
        peerId,
        jobId,
        appId,
        artifactId,
        phase: phases[i],
        pct: Math.round(pct),
        message:
          phases[i] === 'download'
            ? delta
              ? 'downloading delta patch (14.2 MB instead of 84.6 MB)'
              : `${(6 + Math.random() * 8).toFixed(1)} MB/s`
            : delta && phases[i] === 'extract'
              ? 'applying delta patch (zstd)'
              : '',
      });
      later(tick, 150);
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
      // Rolling back is a version change too — the crash counter starts over.
      art.crashCount = 0;
      art.crashLoop = false;
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
    async runPostInstallCmd(appId, artifactId) {
      await sleep(900);
      emit({ type: 'toast', level: 'info', message: `Done: (mock) post-install command for ${appId}/${artifactId}` });
      return { ok: true, code: 0, output: 'mock: command executed', privileged: false };
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

    /* --------------------------------------------------------- v0.5 surface */

    async getConnector() {
      return JSON.parse(JSON.stringify(state.connector));
    },
    async getStacks() {
      return JSON.parse(JSON.stringify(stacks));
    },
    async saveStack(stack) {
      if (!stack || !stack.id) return false;
      const copy = JSON.parse(JSON.stringify(stack));
      const i = stacks.findIndex((s) => s.id === copy.id);
      if (i >= 0) stacks[i] = copy;
      else stacks.push(copy);
      changed();
      return true;
    },
    async deleteStack(id) {
      const before = stacks.length;
      stacks = stacks.filter((s) => s.id !== id);
      changed();
      return stacks.length !== before;
    },
    async runStack(id) {
      return runStackSim(id);
    },
    async stopStack(id) {
      return stopStackSim(id);
    },

    /* --------------------------------------------------------- v0.6 surface */

    async getFleet() {
      return JSON.parse(JSON.stringify({ peers }));
    },
    async fleetShowCode() {
      pairWindow = { code: PAIR_CODE, expiresAt: Date.now() + PAIR_WINDOW_MS };
      // Main arms the window AND announces it, so a hub that was told to pair
      // by the other side sees the same code without asking.
      later(() => emit({ type: 'fleet-pair-code', ...pairWindow }), 20);
      return { ...pairWindow };
    },
    async fleetPair(host, code) {
      await sleep(420);
      if (String(code) !== PAIR_CODE) {
        return { ok: false, error: 'That code did not match — ask the other hub to show a fresh one.' };
      }
      const id = `paired${String(peers.length + 1).padStart(2, '0')}${Date.now().toString(16).slice(-8)}`;
      const peer = {
        id,
        name: String(host).replace(/:\d+$/, ''),
        host: String(host),
        hubVersion: '0.6.0',
        online: true,
        lastSeen: new Date().toISOString(),
        summary: { apps: [{ id: 'nx-hub', name: 'NX Hub', installed: '0.6.0', updates: 0 }] },
      };
      peers = [...peers, peer];
      fleetChanged();
      return { ok: true, peer: { id: peer.id, name: peer.name } };
    },
    async fleetUnpair(id) {
      const before = peers.length;
      peers = peers.filter((p) => p.id !== id);
      fleetChanged();
      return peers.length !== before;
    },
    async fleetInstall(peerId, appId, artifactId) {
      const row = remoteApp(peerId, appId);
      const local = state.apps.find((a) => a.id === appId);
      const version = (local && local.latest && local.latest.version) || (row && row.installed) || '1.0.0';
      const jobId = fleetJobSim(peerId, appId, artifactId, { version, delta: !!(row && row.installed) });
      return jobId ? { ok: true, jobId } : false;
    },
    async fleetLaunch(peerId, appId) {
      const p = findPeer(peerId);
      if (!p) return false;
      emit({ type: 'toast', level: 'info', message: `${p.name}: launching ${appId}…` });
      return { ok: true };
    },
    async fleetUpdateAll(peerId) {
      const p = findPeer(peerId);
      if (!p) return false;
      const waiting = p.summary.apps.filter((a) => a.updates > 0);
      for (const row of waiting) {
        const local = state.apps.find((a) => a.id === row.id);
        fleetJobSim(peerId, row.id, '', {
          version: (local && local.latest && local.latest.version) || row.installed,
          delta: true,
        });
      }
      return { ok: true, jobs: waiting.length };
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
    /* -------------------------------------------------------- v0.5 helpers */

    /** Drop an app off the bus, or bring it back — the live strip appears and
     *  disappears with it. */
    toggleBusClient(appId = 'pulsenx') {
      const wasOn = clientIndex(appId) >= 0;
      if (wasOn) dropClient(appId);
      else addClient(appId);
      emit({
        type: 'toast',
        level: wasOn ? 'warn' : 'info',
        message: wasOn ? `${appId} left the bus` : `${appId} announced itself on the bus`,
      });
      return !wasOn;
    },
    /** Run the prebuilt stack. Successive runs walk every failure path. */
    runMockStack(stackId = 'vr-night') {
      return runStackSim(stackId);
    },
    stopMockStack(stackId = 'vr-night') {
      return stopStackSim(stackId);
    },
    stacks() {
      return JSON.parse(JSON.stringify(stacks));
    },

    /* -------------------------------------------------------- v0.6 helpers */

    /** Take a peer off the network, or bring it back. */
    togglePeer(peerId = 'a1b2c3d4e5f60718') {
      const p = findPeer(peerId);
      if (!p) return false;
      p.online = !p.online;
      p.lastSeen = new Date().toISOString();
      fleetChanged();
      emit({
        type: 'toast',
        level: p.online ? 'info' : 'warn',
        message: p.online ? `${p.name} is back on the network` : `${p.name} went offline`,
      });
      return p.online;
    },
    /** A remote job, complete with fleet-progress rows under the peer. */
    simulateFleetJob(peerId = 'a1b2c3d4e5f60718', appId = 'wivrn-nx') {
      const local = state.apps.find((a) => a.id === appId);
      return fleetJobSim(peerId, appId, '', {
        version: (local && local.latest && local.latest.version) || '',
        delta: true,
      });
    },
    /** The pairing code the fake other hub accepts — for the wrong-code path. */
    pairCode() {
      return PAIR_CODE;
    },
    peers() {
      return JSON.parse(JSON.stringify(peers));
    },
    /**
     * Cycle the crash-loop state of OGB: looping with a rollback → looping with
     * nothing kept (the banner then only informs) → healthy again.
     */
    cycleCrashLoop(appId = 'oscgoesbrrr-nx-patches', artifactId = 'appimage-linux') {
      const { art } = find(appId, artifactId);
      if (!art) return null;
      let stage;
      if (art.crashLoop && art.rollbackAvailable) stage = 'no-rollback';
      else if (art.crashLoop) stage = 'healthy';
      else stage = 'looping';

      if (stage === 'looping') {
        art.crashLoop = true;
        art.crashCount = 4;
        art.rollbackAvailable = true;
        art.prevVersion = art.prevVersion || '1.4.1';
      } else if (stage === 'no-rollback') {
        art.crashLoop = true;
        art.crashCount = 6;
        art.rollbackAvailable = false;
        art.prevVersion = '';
      } else {
        art.crashLoop = false;
        art.crashCount = 0;
      }
      changed();
      emit({
        type: 'toast',
        level: stage === 'healthy' ? 'info' : 'warn',
        message:
          stage === 'healthy'
            ? 'Crash counter reset — the app stayed up'
            : stage === 'no-rollback'
              ? 'Crash loop with no kept previous install'
              : 'Crash loop detected',
      });
      return stage;
    },
    /** A local install that reconstructs the AppImage from a .zpatch. */
    simulateDeltaJob(appId = 'oscgoesbrrr-nx-patches', artifactId = 'appimage-linux') {
      return runJob(appId, artifactId, { delta: true });
    },
    /** Begin drifting the live values (page mode only — see tickFields). */
    startTicking() {
      if (ticking) return;
      ticking = true;
      later(tickFields, 2400);
    },
    /** One field update on demand, for tests and screenshots. */
    tickBus() {
      tickFields();
      return JSON.parse(JSON.stringify(state.connector));
    },
    stop() {
      ticking = false;
      for (const t of timers) host.clearTimeout(t);
      timers.clear();
      for (const token of runs.values()) token.stopped = true;
      runs.clear();
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
    <button class="btn btn-ghost btn-sm" data-mock="disk">populate disk usage</button>
    <button class="btn btn-ghost btn-sm" data-mock="bus">toggle bus client</button>
    <button class="btn btn-ghost btn-sm" data-mock="stack">run mock stack</button>
    <button class="btn btn-ghost btn-sm" data-mock="peer">toggle peer online</button>
    <button class="btn btn-ghost btn-sm" data-mock="fleet-job">simulate remote job</button>
    <button class="btn btn-ghost btn-sm" data-mock="crash">cycle crash loop</button>
    <button class="btn btn-ghost btn-sm" data-mock="delta">simulate delta update</button>`;
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
    else if (what === 'bus') dev.toggleBusClient();
    else if (what === 'stack') dev.runMockStack();
    else if (what === 'peer') dev.togglePeer();
    else if (what === 'fleet-job') dev.simulateFleetJob();
    else if (what === 'crash') dev.cycleCrashLoop();
    else if (what === 'delta') dev.simulateDeltaJob();
  });
  document.body.appendChild(bar);
}

/** Install the mock bridge + dev toolbar. Safe to call once. */
export function installMock() {
  if (typeof window === 'undefined' || window.nxhub) return null;
  const { nxhub, dev } = createMock();
  window.nxhub = nxhub;
  window.__nxhubMock = dev;
  dev.startTicking();
  if (typeof document !== 'undefined' && document.body) toolbar(dev);
  return dev;
}
