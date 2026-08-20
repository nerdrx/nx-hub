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
    // v0.8 — a `.sig` sibling. release.sh signs everything, so the default is
    // true and the interesting rows are the ones that opt OUT: they are what
    // the unsigned marker and the requireSignatures setting are for.
    hasSignature: a.hasSignature !== false,
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

/**
 * v0.7 LAN seeding. SPEC has the download path say "from <peer name>" when the
 * bytes came off another hub; the renderer's chip keys on the "(LAN)" marker,
 * so the mock speaks exactly that dialect.
 */
function lanMessage(phase, peer, pct, size) {
  const full = size || 90_000_000;
  if (phase === 'download') {
    return pct < 25
      ? `from ${peer} (LAN) — asking the fleet before GitHub`
      : `from ${peer} (LAN) — ${mb((full * pct) / 100)} / ${mb(full)}`;
  }
  if (phase === 'verify') return `verifying the sha256 from ${peer} (LAN)`;
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
      // v0.8 — the overlay confines this one and names the config it owns, so
      // the sandbox mark, the "Inherit (overlay: confined)" label and the
      // snapshot section all have something real to say.
      sandbox: 'confined',
      configPaths: ['~/.config/wivrn', '~/.local/share/wivrn'],
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
      // v0.10 — this app never runs on THIS machine, but NX-WIN relays it over
      // the fleet, so its card still needs labelled fields for the remote strip.
      connectorFields: [
        { key: 'bitrate', label: 'Bitrate', unit: 'Mbit/s', kind: 'number' },
        { key: 'fps', label: 'Frames', unit: 'fps', kind: 'number' },
      ],
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
      // v0.8 — the watchdog is on for this one: it is a background bridge, and
      // an unnoticed exit is exactly what keepAlive exists for.
      keepAlive: true,
      configPaths: ['~/.config/pulsenx'],
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
          // The 2.2.0 release predates release.sh signing — no `.sig` sibling.
          hasSignature: false,
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
          // Built by CI rather than release.sh — the second unsigned row, so
          // the strict setting lights up more than one card.
          hasSignature: false,
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
    // v0.8 — SPEC default: unsigned assets from a pinned-key owner are allowed
    // and logged. The toolbar flips it so the unsigned markers appear.
    requireSignatures: false,
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
      // v0.10 [fabric2] — rosters relayed by other hubs over the fleet session.
      // Filled by syncRemote() below from whichever peers are online.
      remote: [],
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

  function runJob(appId, artifactId, { fail = false, target = '', delta = false, lan = '' } = {}) {
    const { app, art } = find(appId, artifactId);
    if (!app || !art) return null;
    // v0.8 [timemachine]: maybeSnapshot() runs BEFORE an install that replaces
    // an existing one. Doing it here (rather than at completion) is what makes
    // the mock self-arming: every update leaves behind exactly the pre-update
    // snapshot that a later rollback to that version will find.
    if (art.installed && art.installed.version) pushSnapshot(appId, art.installed.version, 'pre-update');
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
      job.message = lan
        ? lanMessage(p.phase, lan, job.pct, art.size)
        : delta
          ? deltaMessage(p.phase, art, job.pct)
          : p.phase === 'download'
            ? `${speed} MB/s`
            : '';
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
        record({
          type: 'job-error',
          appId,
          artifactId,
          summary: `${app.name} — ${art.label}: checksum mismatch for ${art.assetName}`,
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
          record({
            type: 'job-done',
            appId,
            artifactId,
            summary: `${app.name} ${version} installed — ${
              art.hasSignature ? 'signature verified' : 'signature unavailable'
            }`,
          });
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

  /* ------------------------------------------- v0.10: field history buffers */

  // SPEC [fabric2]: max 120 samples over a 10-minute window, downsampled to ≤60
  // on getClients() and to ≤20 on the bus. The mock ships the downsampled
  // numbers directly — that is what the renderer actually receives.
  const HISTORY_MAX = 60;
  const REMOTE_HISTORY_MAX = 20;
  const HISTORY_STEP_MS = 2400;

  /**
   * A believable series: a slow sine (the app's own rhythm — a bitrate ramp, a
   * heart settling) plus noise, clamped. A pure random walk drifts off to one
   * edge and sits there, which makes every sparkline eventually look the same.
   */
  function seedSeries(current, { lo, hi, amp, points = 34, phase = 0 }) {
    const now = Date.now();
    const out = [];
    for (let i = points - 1; i >= 0; i--) {
      const t = (points - 1 - i) / points;
      const wave = Math.sin(phase + t * Math.PI * 2.2) * amp;
      const noise = (Math.random() - 0.5) * amp * 0.45;
      const v = Math.max(lo, Math.min(hi, Math.round(current + wave + noise)));
      out.push({ ts: now - i * HISTORY_STEP_MS, v });
    }
    return out;
  }

  /** Per-field ranges, so a bitrate and a heart rate move at their own scale. */
  const FIELD_RANGE = {
    hr: { lo: 52, hi: 148, amp: 11 },
    bitrate: { lo: 12, hi: 150, amp: 18 },
    latency_ms: { lo: 14, hi: 120, amp: 9 },
    receivers: { lo: 0, hi: 40, amp: 4 },
    fps: { lo: 45, hi: 120, amp: 7 },
  };

  function seedHistories(fields, opts = {}) {
    const out = {};
    let phase = 0;
    for (const [key, value] of Object.entries(fields || {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const range = FIELD_RANGE[key] || { lo: 0, hi: Math.max(1, value * 2), amp: Math.max(1, value * 0.12) };
      out[key] = seedSeries(value, { ...range, points: opts.points || 34, phase });
      // Offset each field so two lines on one strip are not the same shape.
      phase += 1.1;
    }
    return out;
  }

  /** Append the current numeric fields as one more sample, then trim. */
  function pushHistory(client, max = HISTORY_MAX) {
    if (!client) return;
    const bag = client.history || (client.history = {});
    const ts = Date.now();
    for (const [key, value] of Object.entries(client.fields || {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const series = bag[key] || (bag[key] = []);
      series.push({ ts, v: value });
      if (series.length > max) series.splice(0, series.length - max);
    }
  }

  for (const client of state.connector.clients) client.history = seedHistories(client.fields);

  /* -------------------------------------------- v0.10: federated rosters */

  /**
   * What each peer would be relaying if its session were up. Kept separately
   * from `state.connector.remote` because SPEC clears a received roster the
   * moment the session drops — syncRemote() is that rule, in one place.
   *
   * workshop-pc relays an app that is NOT on this machine's bus, which is the
   * state the card surface is really about: LIVE, but somewhere else.
   */
  const remoteRosters = {
    a1b2c3d4e5f60718: () => [
      {
        app: 'oscgoesbrrr-nx-patches',
        version: '1.6.0',
        pid: 8123,
        since: new Date(Date.now() - 52 * 60000).toISOString(),
        lastSeen: new Date().toISOString(),
        fields: { receivers: 22, smoothing: true },
        history: seedHistories({ receivers: 22 }, { points: REMOTE_HISTORY_MAX }),
      },
    ],
    c0ffee11deadbeef: () => [
      {
        app: 'wivrn-nx-windows',
        version: '0.4.1',
        pid: 6612,
        since: new Date(Date.now() - 4 * 60000).toISOString(),
        lastSeen: new Date().toISOString(),
        fields: { bitrate: 112, fps: 90 },
        history: seedHistories({ bitrate: 112, fps: 90 }, { points: REMOTE_HISTORY_MAX }),
      },
    ],
  };

  /** Rebuild connector.remote from the peers that are actually answering. */
  function syncRemote(opts = {}) {
    state.connector.remote = peers
      .filter((p) => p.online && remoteRosters[p.id])
      .map((p) => ({ peerId: p.id, peerName: p.name, clients: remoteRosters[p.id]() }));
    if (!opts.quiet) busChanged();
    return state.connector.remote;
  }

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
      // A client that just joined has one sample, which is exactly the
      // single-point case the sparkline has to survive.
      history: seedHistories(fieldsFor(appId), { points: 1 }),
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
      // v0.10 — every tick is one more sample in the ring buffer, which is what
      // makes the sparklines move on screen instead of sitting there seeded.
      pushHistory(client);
    }
    // A peer's relayed roster ticks too (its own hub is doing the same thing),
    // so the remote strips are alive rather than a frozen screenshot.
    for (const peer of state.connector.remote || []) {
      for (const client of peer.clients || []) {
        const f = client.fields;
        if (typeof f.bitrate === 'number') f.bitrate = jitter(f.bitrate, 12, 150, 20);
        if (typeof f.fps === 'number') f.fps = jitter(f.fps, 45, 120, 8);
        if (typeof f.receivers === 'number') f.receivers = jitter(f.receivers, 0, 40, 3);
        client.lastSeen = new Date().toISOString();
        pushHistory(client, REMOTE_HISTORY_MAX);
      }
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
    // v0.7 — the cross-hub shape SPEC describes: wake the Windows box, wait for
    // its helper's port to answer over the LAN, then bring the local half up.
    {
      id: 'vr-night-both-machines',
      name: 'VR Night (both machines)',
      steps: [
        {
          appId: null,
          artifactId: null,
          peer: 'c0ffee11deadbeef',
          action: 'wake',
          health: { type: 'peer-online', timeoutMs: 120000 },
        },
        {
          appId: 'wivrn-nx-windows',
          artifactId: 'windows-zip-windows',
          peer: 'c0ffee11deadbeef',
          health: { type: 'port', port: 9757, timeoutMs: 45000 },
        },
        { appId: 'pulsenx', artifactId: 'appimage-linux', health: { type: 'connector', timeoutMs: 20000 } },
        {
          appId: 'oscgoesbrrr-nx-patches',
          artifactId: 'appimage-linux',
          health: { type: 'delay', timeoutMs: 1500 },
          optional: true,
        },
      ],
    },
  ];

  // Every run walks a different path so the UI can reach all of its states:
  // 0 = everything comes up · 1 = the optional step times out and the run
  // carries on · 2 = a required step times out and the run stops there.
  let runMode = 0;
  const runs = new Map(); // stackId → token

  // v0.7 — a peered step's events carry the peer id in their extras, which is
  // what lets the tile prefix its status line with the other hub's name.
  function progress(stackId, stepIndex, appId, phase, extras = {}) {
    emit({ type: 'stack-progress', stackId, stepIndex, appId, phase, ...extras });
  }

  function stepExtras(step) {
    return step && step.peer ? { peer: step.peer } : {};
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
      const extras = stepExtras(s);
      const fails =
        (token.mode === 1 && !!s.optional) || (token.mode === 2 && i === stack.steps.length - 1);

      progress(stackId, i, s.appId, 'launching', extras);
      later(() => {
        if (token.stopped) return;
        progress(stackId, i, s.appId, 'waiting', extras);
        later(() => {
          if (token.stopped) return;
          if (fails) {
            progress(stackId, i, s.appId, 'failed', extras);
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
            // A wake step that succeeded brings the peer back onto the network.
            if (s.action === 'wake' && s.peer) wakePeer(s.peer, { quiet: true });
            progress(stackId, i, s.appId, 'healthy', extras);
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
    const peered = stack.steps.find((s) => s.peer) || null;
    progress(stackId, at, stack.steps[at] ? stack.steps[at].appId : '', 'stopping', stepExtras(stack.steps[at]));
    later(() => {
      // Reverse order, the way main takes a stack down: every app in the stack
      // gets a shutdown-request, not just the ones this run happened to start.
      for (const step of [...stack.steps].reverse()) if (step.appId) dropClient(step.appId);
      // v0.7 — a stack that reached another hub reports whether the far side
      // confirmed. The mock always gets a clean remote stop.
      progress(stackId, 0, stack.steps[0] ? stack.steps[0].appId : '', 'stopped', {
        ...(peered ? { peer: peered.peer, how: 'remote-stop' } : {}),
      });
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
      hubVersion: '0.7.0',
      // v0.7 — resolved from /proc/net/arp on every session. Online, so it
      // gets no Wake button: there is nothing to wake.
      mac: '3c:7c:3f:1a:44:90',
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
      // Offline and never seen from this side long enough to learn its MAC:
      // the Wake button must not appear on this one.
      online: false,
      lastSeen: new Date(Date.now() - 41 * 60000).toISOString(),
      summary: {
        apps: [
          { id: 'wivrn-nx', name: 'WiVRn NX', installed: '1.8.0', updates: 1 },
          { id: 'pulsenx', name: 'PulseNX', installed: '', updates: 0 },
        ],
      },
    },
    // v0.7 — the Windows box the cross-hub stack wakes. Offline WITH a stored
    // MAC: the only peer that can show a Wake button.
    {
      id: 'c0ffee11deadbeef',
      name: 'NX-WIN',
      host: '192.168.1.64',
      hubVersion: '0.7.0',
      mac: 'a8:a1:59:22:0d:3e',
      online: false,
      lastSeen: new Date(Date.now() - 6 * 3600000).toISOString(),
      summary: {
        apps: [
          { id: 'wivrn-nx-windows', name: 'WiVRn NX for SteamVR', installed: '0.4.1', updates: 0 },
          { id: 'nx-hub', name: 'NX Hub', installed: '0.7.0', updates: 0 },
        ],
      },
    },
  ];

  /* -------------------------------------------------------------- dev links */

  // dataDir/dev.json, resolved the way [dev-tools] hands it over: a bare array
  // whose entries already say whether the folder is still there (`exists`) and
  // whether the id shadows a catalogue app (`known` + `appName`).
  //
  // One link shadows a discovered app (so its card wears the DEV mark as well
  // as getting its own tile) and one stands alone; the standalone one carries a
  // launchCmd and a path with characters that would break naive markup, because
  // that path is rendered in the tile menu.
  const DEV_SEED = () => [
    {
      appId: 'wivrn-nx',
      name: 'wivrn-nx',
      appName: 'WiVRn NX',
      known: true,
      exists: true,
      path: '/home/nerdrx/src/wivrn-nx',
      launchCmd: '',
    },
    {
      appId: 'nx-sandbox',
      name: 'NX Sandbox',
      appName: '',
      known: false,
      exists: true,
      path: '/home/nerdrx/src/nx "sandbox" & co',
      launchCmd: './build/sandbox --verbose',
    },
  ];
  let devLinks = DEV_SEED();
  let devPid = 90210;

  /* ------------------------------------------------ v0.8: the flight recorder */

  // dataDir/events.jsonl, as query() hands it back: newest-first records of
  // {ts, type, appId?, …, summary}. The seed is 40 entries spread over three
  // local days and every type the recorder emits, so the day separators, all
  // seven filter chips and the "Load more" cursor are all reachable without
  // touching a single toolbar button.
  const HOUR = 3600000;
  const DAY = 86400000;

  function EVENT_SEED() {
    const now = Date.now();
    // Anchored to local noon of each day so the three buckets stay three
    // buckets whatever time of day the mock is opened.
    const noon = (daysAgo) => {
      const d = new Date(now - daysAgo * DAY);
      d.setHours(12, 0, 0, 0);
      return d.getTime();
    };
    const at = (daysAgo, hoursFromNoon, mins = 0) => noon(daysAgo) + hoursFromNoon * HOUR + mins * 60000;

    const rows = [
      // ---- today
      ['job-done', 0, -0.4, 12, { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux' }, 'WiVRn NX 1.9.2 installed — signature verified'],
      ['connector-join', 0, -0.6, 3, { appId: 'wivrn-nx' }, 'WiVRn NX 1.9.2 joined the bus (pid 40877)'],
      ['connector-join', 0, -0.9, 41, { appId: 'pulsenx' }, 'PulseNX 2.2.0 joined the bus (pid 40211)'],
      ['stack-progress', 0, -1.1, 8, { stackId: 'vr-night' }, 'Stack “VR Night” finished — 3 steps in 41s'],
      ['supervisor', 0, -1.4, 22, { appId: 'pulsenx', artifactId: 'appimage-linux' }, 'PulseNX exited unexpectedly — restarting (attempt 1)', { action: 'restarting', attempt: 1, delayMs: 2000 }],
      ['connector-leave', 0, -1.5, 2, { appId: 'pulsenx' }, 'PulseNX left the bus'],
      ['job-error', 0, -2.2, 17, { appId: 'banish-protocol', artifactId: 'archive-dir-linux' }, 'checksum mismatch for limbo-protocol-linux-0.2.0.zip — the download was discarded'],
      ['update-available', 0, -2.6, 5, { appId: 'oscgoesbrrr-nx-patches' }, 'OGB NX-Patches 1.6.0 is available (installed: 1.4.2)'],
      ['fleet-progress', 0, -3.1, 30, { peerId: 'aa11bb22cc33dd44', appId: 'wivrn-nx' }, 'workshop-pc finished installing WiVRn NX 1.9.2'],
      ['job-done', 0, -3.4, 9, { appId: 'quadforge', artifactId: 'blender-addon-linux' }, 'QuadForge 0.9.0 installed — signature unavailable'],
      ['stack-progress', 0, -4.0, 44, { stackId: 'headset-arrives' }, 'Stack “Headset arrives” triggered by an adb device'],
      ['connector-leave', 0, -4.6, 15, { appId: 'wivrn-nx' }, 'WiVRn NX left the bus'],
      // A summary built from another program's output. It is markup-shaped on
      // purpose: the renderer must escape it, and this is the row that proves it.
      ['job-error', 0, -5.2, 6, { appId: 'wivrn-nx', artifactId: 'apk-adb-android' }, 'adb: install failed <img src=x onerror=alert(1)> "INSTALL_FAILED_VERSION_DOWNGRADE" & no device'],
      ['supervisor', 0, -5.9, 38, { appId: 'oscgoesbrrr-nx-patches', artifactId: 'appimage-linux' }, 'OGB NX-Patches kept exiting — the watchdog gave up after 5 attempts', { action: 'gave-up', attempt: 5 }],

      // ---- yesterday
      ['job-done', 1, 1.2, 4, { appId: 'pulsenx', artifactId: 'appimage-linux' }, 'PulseNX 2.2.0 installed — signature verified'],
      ['update-available', 1, 0.7, 19, { appId: 'wivrn-nx' }, 'WiVRn NX 1.9.2 is available (installed: 1.9.1)'],
      ['connector-join', 1, 0.2, 51, { appId: 'pulsenx' }, 'PulseNX 2.2.0 joined the bus (pid 39106)'],
      ['fleet-progress', 1, -0.4, 27, { peerId: 'aa11bb22cc33dd44', appId: 'pulsenx' }, 'workshop-pc finished installing PulseNX 2.2.0'],
      ['fleet-progress', 1, -1.1, 3, { peerId: '99887766554433aa', appId: 'wivrn-nx' }, 'living-room could not be reached — the update was not sent'],
      ['stack-progress', 1, -1.8, 36, { stackId: 'vr-night' }, 'Stack “VR Night” stopped at step 2 — the port never answered'],
      ['job-error', 1, -2.4, 11, { appId: 'pulsenx', artifactId: 'windows-portable-windows' }, 'no signature for PulseNX-2.2.0-windows-portable.exe and signed releases are required'],
      ['supervisor', 1, -3.0, 47, { appId: 'pulsenx', artifactId: 'appimage-linux' }, 'PulseNX exited unexpectedly — restarting (attempt 2)', { action: 'restarting', attempt: 2, delayMs: 4000 }],
      ['connector-leave', 1, -3.5, 21, { appId: 'pulsenx' }, 'PulseNX left the bus'],
      ['job-done', 1, -4.2, 33, { appId: 'oscgoesbrrr-nx-patches', artifactId: 'appimage-linux' }, 'OGB NX-Patches 1.4.2 installed — signature verified'],
      ['connector-join', 1, -4.9, 8, { appId: 'wivrn-nx' }, 'WiVRn NX 1.9.1 joined the bus (pid 38220)'],
      ['update-available', 1, -5.4, 14, { appId: 'pulsenx' }, 'PulseNX 2.3.0 is available (installed: 2.2.0)'],
      ['stack-progress', 1, -6.0, 29, { stackId: 'vr-night-both-machines' }, 'Stack “VR Night (both machines)” woke NX-WIN and finished'],
      ['supervisor', 1, -6.5, 12, { appId: 'pulsenx', artifactId: 'appimage-linux' }, 'PulseNX came back up — the watchdog stood down', { action: 'restarting', attempt: 3 }],

      // ---- two days ago
      ['job-done', 2, 2.0, 16, { appId: 'wivrn-nx', artifactId: 'apk-adb-android' }, 'WiVRn NX 1.8.0 installed onto PA7HA0M123 — signature verified'],
      ['connector-join', 2, 1.4, 42, { appId: 'wivrn-nx' }, 'WiVRn NX 1.9.1 joined the bus (pid 37004)'],
      ['fleet-progress', 2, 0.9, 7, { peerId: 'c0ffee11deadbeef', appId: 'wivrn-nx-windows' }, 'NX-WIN finished installing WiVRn NX for SteamVR 0.4.1'],
      ['job-error', 2, 0.3, 25, { appId: 'quadforge', artifactId: 'blender-addon-linux' }, 'GitHub rate limit reached — discovery gave up for now'],
      ['update-available', 2, -0.5, 39, { appId: 'quadforge' }, 'QuadForge 0.9.0 is available (nothing installed)'],
      ['supervisor', 2, -1.2, 13, { appId: 'pulsenx', artifactId: 'appimage-linux' }, 'PulseNX exited unexpectedly — restarting (attempt 1)', { action: 'restarting', attempt: 1, delayMs: 2000 }],
      ['connector-leave', 2, -1.9, 50, { appId: 'wivrn-nx' }, 'WiVRn NX left the bus'],
      ['stack-progress', 2, -2.6, 4, { stackId: 'headset-arrives' }, 'Stack “Headset arrives” finished — 2 steps in 18s'],
      ['job-done', 2, -3.3, 46, { appId: 'nx-hub', artifactId: 'appimage-linux' }, 'NX Hub 0.1.0 installed — signature verified'],
      ['fleet-progress', 2, -4.1, 20, { peerId: 'aa11bb22cc33dd44', appId: 'oscgoesbrrr-nx-patches' }, 'workshop-pc started installing OGB NX-Patches 1.4.2'],
      ['job-error', 2, -4.8, 31, { appId: 'wivrn-nx-windows', artifactId: 'windows-zip-windows' }, 'nothing installable on this machine — the Windows build was skipped'],
      ['connector-join', 2, -5.5, 9, { appId: 'pulsenx' }, 'PulseNX 2.1.0 joined the bus (pid 35880)'],
    ];

    return rows.map(([type, d, h, m, ids, summary, data]) => ({
      ts: at(d, h, m),
      type,
      ...ids,
      summary,
      ...(data ? { data } : {}),
    }));
  }

  let events = EVENT_SEED();

  /** Append the way the ipc emit-tap does: newest wins, the file only grows. */
  function record(event) {
    if (!event || !event.type) return null;
    const row = { ts: Date.now(), ...event };
    events = [row, ...events];
    return row;
  }

  /**
   * The recorder's own day dividers. SPEC has them in the stream; the renderer
   * is documented to drop them and derive its own separators, so emitting them
   * here is the only way that path stays exercised.
   */
  function withDayDividers(list) {
    const out = [];
    let day = '';
    for (const e of list) {
      const d = new Date(e.ts);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (key !== day) {
        day = key;
        out.push({ ts: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), type: 'day', summary: key });
      }
      out.push(e);
    }
    return out;
  }

  /* ------------------------------------------------ v0.8: config snapshots */

  // dataDir/snapshots/<appId>/<ts>-<ver>-<reason>.tar.zst, newest first.
  //
  // The OGB entry is the load-bearing one: its version matches the crash
  // banner's "Roll back to 1.4.1", so the affinity checkbox is reachable from
  // the default state without arming anything. WiVRn deliberately has NO
  // pre-update at 1.9.1 — the miss path has to be reachable too.
  const SNAPSHOT_SEED = () => ({
    'wivrn-nx': [
      { file: '2026-08-13T081200-1.9.1-pre-update.tar.zst', ts: iso(3), version: '1.9.1', reason: 'pre-uninstall', bytes: 2_340_000 },
      { file: '2026-08-05T190400-1.9.0-pre-update.tar.zst', ts: iso(11), version: '1.9.0', reason: 'pre-update', bytes: 2_180_000 },
      { file: '2026-07-28T101900-1.8.0-manual.tar.zst', ts: iso(19), version: '1.8.0', reason: 'manual', bytes: 1_960_000 },
    ],
    'oscgoesbrrr-nx-patches': [
      { file: '2026-06-13T224100-1.4.1-pre-update.tar.zst', ts: iso(64), version: '1.4.1', reason: 'pre-update', bytes: 486_000 },
      { file: '2026-05-02T113300-1.4.0-pre-update.tar.zst', ts: iso(106), version: '1.4.0', reason: 'pre-update', bytes: 470_000 },
    ],
    pulsenx: [
      { file: '2026-08-05T072600-2.2.0-pre-update.tar.zst', ts: iso(11), version: '2.2.0', reason: 'pre-update', bytes: 41_000 },
      { file: '2026-08-04T235900-2.2.0-pre-restore.tar.zst', ts: iso(12), version: '2.2.0', reason: 'pre-restore', bytes: 40_600 },
    ],
    // A filename that would break naive markup. Real filenames cannot look like
    // this, which is exactly why the escaping has to be proven against one.
    quadforge: [
      { file: '2026-08-01T120000-0.8.0-"><img src=x onerror=alert(1)>.tar.zst', ts: iso(15), version: '0.8.0', reason: 'manual', bytes: 12_400 },
    ],
  });

  let snapshots = SNAPSHOT_SEED();

  const snapsFor = (appId) => (snapshots[appId] || []).slice();

  /** maybeSnapshot(): newest first, retention keeps the last 5 per app. */
  function pushSnapshot(appId, version, reason) {
    if (!appId || !version) return null;
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const snap = {
      file: `${stamp}-${version}-${reason}.tar.zst`,
      ts: now.toISOString(),
      version: String(version),
      reason,
      bytes: 40_000 + Math.round(Math.random() * 2_000_000),
    };
    snapshots[appId] = [snap, ...snapsFor(appId).filter((s) => s.file !== snap.file)].slice(0, 5);
    return snap;
  }

  /* ------------------------------------------ v0.10: ecosystem checkpoints */

  /**
   * `when` accepts what the recorder accepts: epoch ms, an ISO string, or a
   * relative form ("24h", "3d", "90m"). Everything else falls back to "an hour
   * ago", because a checkpoint sheet with no moment at all is not a state worth
   * being able to reach.
   */
  function resolveWhen(when) {
    if (typeof when === 'number' && Number.isFinite(when) && when > 0) return Math.round(when);
    const raw = String(when || '').trim();
    const rel = /^(\d+)\s*(m|h|d)$/i.exec(raw);
    if (rel) {
      const n = Number(rel[1]);
      const unit = rel[2].toLowerCase();
      const ms = unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
      return Date.now() - n * ms;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    return Date.now() - 3600000;
  }

  /**
   * The reconstruction. Deliberately mixed: something to install, something to
   * remove, several apps already where they belong, and TWO rows that cannot be
   * placed because their tag is gone — the uncertain path is the one that is
   * easy to get wrong and impossible to see without a fixture for it.
   */
  const CHECKPOINT_SEED = [
    { appId: 'wivrn-nx', artifactId: 'tarball-prefix-linux', version: '1.9.1', action: 'install', snapshot: true },
    { appId: 'pulsenx', artifactId: 'appimage-linux', action: 'none' },
    { appId: 'quadforge', artifactId: 'blender-addon-linux', version: '', action: 'remove', snapshot: true },
    // The SAME app, its other artifact, moving the other way: at that moment the
    // headset APK was not on the Pico yet. Two rows under one name is the case
    // the table has to disambiguate, and the one a plan keyed only by app id
    // would silently swallow — so the fixture insists on it.
    { appId: 'wivrn-nx', artifactId: 'apk-adb-android', version: '', action: 'remove' },
    { appId: 'nx-hub', artifactId: 'appimage-linux', action: 'none' },
    {
      appId: 'oscgoesbrrr-nx-patches',
      artifactId: 'appimage-linux',
      version: '1.4.1',
      action: 'install',
      uncertain: true,
      reason: 'release v1.4.1 is no longer published',
    },
    {
      appId: 'banish-protocol',
      artifactId: 'archive-dir-linux',
      version: '0.2.0',
      action: 'install',
      uncertain: true,
      reason: 'the recorder never saw which asset was installed',
    },
  ];

  function checkpointPlan(when) {
    const ts = resolveWhen(when);
    const apps = [];
    for (const row of CHECKPOINT_SEED) {
      const { art } = find(row.appId, row.artifactId);
      const currentVersion = (art && art.installed && art.installed.version) || '';
      // Nothing installed, nothing to remove. Main computes the action from the
      // two versions and so can never emit this pair; the seed is written by hand
      // and can, which would put "not installed → not installed · REMOVE" on the
      // screen the moment the app it names has not been installed yet.
      if (row.action === 'remove' && !currentVersion) continue;
      // `none` rows are the reconstruction saying "already right" — so their
      // target IS whatever is installed now.
      const version = row.action === 'none' ? currentVersion : row.version || '';
      const snap = row.snapshot ? snapsFor(row.appId)[0] : null;
      apps.push({
        appId: row.appId,
        artifactId: row.artifactId,
        version,
        currentVersion,
        action: row.action,
        ...(snap ? { snapshot: snap.file } : {}),
        ...(row.uncertain ? { uncertain: true, reason: row.reason } : {}),
      });
    }
    return { ts, apps };
  }

  // Flipped by the toolbar so the failure ending is reachable without breaking
  // anything: the restore stops partway and says so.
  let checkpointFails = false;

  /**
   * The vocabulary here is [replay]'s, verbatim: `planning` with `appId: null`,
   * then `installing`/`removing` per app, a per-app `failed` when a step breaks
   * (the walk CONTINUES — a failing step does not abort the rest), and one
   * closing verdict with `appId: null`. There is deliberately NO per-app
   * `done`: main never emits one, and the renderer's rule that the verdict
   * closes every still-open row only gets exercised if the mock is that honest.
   */
  function restoreCheckpointSim(when, opts = {}) {
    const plan = checkpointPlan(when);
    const work = plan.apps.filter((a) => !a.uncertain && a.action !== 'none');
    const configs = !!(opts && opts.configs);
    let failures = 0;
    let i = 0;

    emit({ type: 'checkpoint-progress', phase: 'planning', appId: null, artifactId: null });

    const step = () => {
      if (i >= work.length) {
        emit({ type: 'checkpoint-progress', phase: failures ? 'failed' : 'done', appId: null, artifactId: null });
        record({
          type: 'job-done',
          summary: `Restored ${work.length} app${work.length === 1 ? '' : 's'} to an earlier checkpoint`,
        });
        recompute(state.apps, state.settings);
        changed();
        emit({ type: 'toast', level: 'info', message: 'Checkpoint restored' });
        return;
      }
      const row = work[i++];
      const phase = row.action === 'remove' ? 'removing' : 'installing';
      emit({ type: 'checkpoint-progress', phase, appId: row.appId, artifactId: row.artifactId });

      // Halfway through, if armed: a plausible failure (a tag that 404s now).
      // The walk goes ON — that is what main does, and the closing verdict is
      // what turns the run red.
      if (checkpointFails && i === Math.ceil(work.length / 2)) {
        failures += 1;
        later(() => {
          emit({
            type: 'checkpoint-progress',
            phase: 'failed',
            appId: row.appId,
            artifactId: row.artifactId,
            error: `${row.appId}: that release asset is no longer downloadable`,
          });
          later(step, 260);
        }, 420);
        return;
      }

      later(() => {
        // The plan really is applied — the cards behind the sheet have to end up
        // agreeing with the table, or the sheet is theatre.
        const { art } = find(row.appId, row.artifactId);
        if (art) {
          if (row.action === 'remove') art.installed = null;
          else {
            art.installed = {
              version: row.version,
              path: `/home/nerdrx/Applications/nx/${row.appId}/${row.artifactId}`,
              installedAt: new Date().toISOString(),
            };
          }
        }
        // No per-app "done": main does not send one, so neither does this.
        if (configs && row.snapshot) {
          emit({ type: 'checkpoint-progress', phase: 'config', appId: row.appId, artifactId: row.artifactId });
          later(step, 320);
          return;
        }
        later(step, 260);
      }, 460);
    };

    later(step, 200);
    return { ok: true, planned: work.length };
  }

  /* ------------------------------------------------------ v0.10: deep audit */

  // Two broken installs, each with a different failure class, plus clean rows —
  // and one path with characters that would break naive markup, because the
  // audit prints filesystem paths and a filename can contain anything.
  const AUDIT_SEED = () => [
    { appId: 'pulsenx', artifactId: 'appimage-linux', ok: true, problems: [] },
    {
      appId: 'oscgoesbrrr-nx-patches',
      artifactId: 'appimage-linux',
      ok: false,
      problems: [
        {
          kind: 'missing-binary',
          path: '/home/nerdrx/Applications/nx/oscgoesbrrr-nx-patches/OGB-NX.AppImage',
          detail: 'recorded by the installer, not on disk now',
        },
        {
          kind: 'missing-desktop-entry',
          path: '~/.local/share/applications/nx-oscgoesbrrr-nx-patches.desktop',
          detail: '',
        },
      ],
    },
    {
      appId: 'wivrn-nx',
      artifactId: 'tarball-prefix-linux',
      ok: false,
      problems: [
        {
          kind: 'hash-mismatch',
          path: '/home/nerdrx/Applications/nx/wivrn-nx/bin/wivrn-server',
          detail: 'sha256 differs from the published asset',
        },
        {
          kind: 'not-executable',
          path: '/home/nerdrx/Applications/nx/wivrn-nx/bin/"wivrn helper" & co',
          detail: 'mode 0644',
        },
      ],
    },
    { appId: 'quadforge', artifactId: 'blender-addon-linux', ok: true, problems: [] },
    { appId: 'nx-hub', artifactId: 'appimage-linux', ok: true, problems: [] },
    // [audit] cannot check a payload that lives on a headset. "ok" on this row
    // means "nothing here to look at" — the UI has to say that, not tick it.
    {
      appId: 'wivrn',
      artifactId: 'apk-android',
      ok: true,
      deviceResident: true,
      problems: [],
      notes: ['apk: installed on a device — files not checked here'],
    },
  ];

  let auditRows = AUDIT_SEED();

  /**
   * A peer going up or down changes TWO things: the fleet list, and the bus
   * rosters that hub was relaying (SPEC clears a roster when its session drops).
   * Doing both here means no caller can remember one and forget the other.
   */
  const fleetChanged = () => {
    syncRemote({ quiet: true });
    emit({ type: 'fleet-changed' });
    emit({ type: 'connector-changed' });
  };
  const findPeer = (id) => peers.find((p) => p.id === id) || null;

  // The bus roster the online peers are relaying right now (workshop-pc from
  // the first frame; NX-WIN joins the moment it is woken).
  syncRemote({ quiet: true });

  /**
   * v0.7 wake-on-LAN. Magic packets are fire-and-forget, so the bool only says
   * "the packets went out" — the machine answering later is a separate event,
   * which is exactly why the toast has to promise nothing more than that.
   */
  function wakePeer(peerId, opts = {}) {
    const p = findPeer(peerId);
    if (!p || !p.mac) return false;
    if (!opts.quiet) emit({ type: 'toast', level: 'info', message: `Waking ${p.name} (${p.mac})…` });
    // A real box takes tens of seconds; the mock takes two, so the whole
    // sequence stays watchable.
    later(() => {
      p.online = true;
      p.lastSeen = new Date().toISOString();
      fleetChanged();
      if (!opts.quiet) emit({ type: 'toast', level: 'info', message: `${p.name} answered — it is on the network` });
    }, 2000);
    return true;
  }

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

    /* --------------------------------------------------------- v0.7 surface */

    async getDevLinks() {
      return JSON.parse(JSON.stringify(devLinks));
    },
    /**
     * SPEC: devRun toasts on its own and REJECTS with a readable message — the
     * renderer must show that message verbatim rather than inventing one.
     */
    async devRun(id) {
      const link = devLinks.find((l) => l.appId === id);
      if (!link) throw new Error(`No dev link called “${id}”.`);
      if (!link.exists) {
        throw new Error(`${link.path} is not there any more — unlink it or put the folder back.`);
      }
      const cmd = link.launchCmd || './run.sh';
      emit({
        type: 'toast',
        level: 'info',
        message: `Running ${link.name} from ${link.path} (${cmd})`,
      });
      return { ok: true, pid: ++devPid, cmd, source: link.launchCmd ? 'launchCmd' : 'heuristic' };
    },
    /** Hands back the fresh list, so the caller never needs a second round trip. */
    async devUnlink(id) {
      const before = devLinks.length;
      devLinks = devLinks.filter((l) => l.appId !== id);
      emit({ type: 'dev-links-changed' });
      changed();
      return { ok: devLinks.length !== before, links: JSON.parse(JSON.stringify(devLinks)) };
    },
    async fleetWake(peerId) {
      return wakePeer(peerId);
    },

    /* --------------------------------------------------------- v0.8 surface */

    /**
     * query({since, until, type, appId, limit}) → newest first. `until` is
     * exclusive so the renderer's "lower until to the oldest ts held" cursor
     * always advances instead of re-serving the same tail forever.
     */
    async getEvents(query) {
      const q = query && typeof query === 'object' ? query : {};
      let list = events.slice().sort((a, b) => b.ts - a.ts);
      const until = Number(q.until);
      const since = Number(q.since);
      if (Number.isFinite(until) && until > 0) list = list.filter((e) => e.ts < until);
      if (Number.isFinite(since) && since > 0) list = list.filter((e) => e.ts >= since);
      if (q.type) list = list.filter((e) => e.type === q.type);
      if (q.appId) list = list.filter((e) => e.appId === q.appId);
      const limit = Math.max(1, Math.min(500, Number(q.limit) || 100));
      // Dividers are added AFTER the slice: `limit` counts real records, which
      // is the only reading under which a page size stays a page size.
      return JSON.parse(JSON.stringify(withDayDividers(list.slice(0, limit))));
    },

    async getSnapshots(appId) {
      return JSON.parse(JSON.stringify(snapsFor(appId)));
    },

    /**
     * Untars over $HOME after snapshotting the current config as "pre-restore".
     * It toasts on its own — the renderer is documented not to say it twice.
     */
    async restoreSnapshot(appId, file) {
      const list = snapsFor(appId);
      const snap = list.find((s) => s.file === file);
      const app = state.apps.find((a) => a.id === appId);
      if (!snap) return { ok: false, restored: [], preRestore: '' };
      const preRestore = `${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${snap.version}-pre-restore.tar.zst`;
      snapshots[appId] = [
        { file: preRestore, ts: new Date().toISOString(), version: snap.version, reason: 'pre-restore', bytes: snap.bytes },
        ...list,
      ].slice(0, 5);
      const restored = (app && app.configPaths) || ['~/.config/' + appId];
      record({
        type: 'job-done',
        appId,
        summary: `${(app && app.name) || appId}: config restored from ${snap.version} (${restored.length} path${restored.length === 1 ? '' : 's'})`,
      });
      changed();
      emit({
        type: 'toast',
        level: 'info',
        message: `${(app && app.name) || appId} — config restored from ${snap.version}`,
      });
      return { ok: true, restored: restored.slice(), preRestore };
    },

    /* -------------------------------------------------------- v0.10 surface */

    async getCheckpoint(when) {
      return JSON.parse(JSON.stringify(checkpointPlan(when)));
    },

    /**
     * Answers as soon as the walk is ARMED, not when it finishes — the
     * checkpoint-progress events are the real narration, and a renderer that
     * waited for this promise would show nothing for ten seconds and then
     * everything at once.
     */
    async restoreCheckpoint(when, opts) {
      return restoreCheckpointSim(when, opts || {});
    },

    async getAudit(appId) {
      const rows = appId ? auditRows.filter((r) => r.appId === appId) : auditRows;
      return JSON.parse(JSON.stringify(rows));
    },

    /**
     * Repair is a reinstall through the normal pipeline, so it returns a jobId
     * and everything after that arrives as ordinary job events. The row only
     * goes green once the job lands — a button that instantly declares success
     * would be lying for the duration of the download.
     */
    async repairInstall(appId, artifactId) {
      const row = auditRows.find((r) => r.appId === appId && r.artifactId === artifactId);
      const jobId = runJob(appId, artifactId);
      if (row) {
        later(() => {
          row.ok = true;
          row.problems = [];
          emit({ type: 'toast', level: 'info', message: `${appId} reinstalled — the install verifies clean now` });
        }, 2400);
      }
      return jobId;
    },

    /** Hands back the fresh list, so the section never needs a second trip. */
    async deleteSnapshot(appId, file) {
      const before = snapsFor(appId);
      snapshots[appId] = before.filter((s) => s.file !== file);
      return { ok: snapshots[appId].length !== before.length, snapshots: JSON.parse(JSON.stringify(snapshots[appId])) };
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

    /* -------------------------------------------------------- v0.8 helpers */

    /** Read-only views the tests drive assertions from. */
    events() {
      return JSON.parse(JSON.stringify(events));
    },
    snapshots(appId) {
      return appId ? JSON.parse(JSON.stringify(snapsFor(appId))) : JSON.parse(JSON.stringify(snapshots));
    },
    /**
     * One fresh record, so the sheet's live tail (2s debounce) has something to
     * arrive with while it is open.
     */
    logEvent(type = 'connector-join', appId = 'pulsenx') {
      const app = state.apps.find((a) => a.id === appId);
      return record({
        type,
        appId,
        summary: `${(app && app.name) || appId} joined the bus (pid ${40000 + Math.floor(Math.random() * 9000)})`,
      });
    },
    seedSnapshot(appId, version, reason = 'pre-update') {
      const snap = pushSnapshot(appId, version, reason);
      changed();
      return snap ? JSON.parse(JSON.stringify(snap)) : null;
    },

    /**
     * The watchdog, both endings. A give-up ALSO toasts from main — the mock
     * has to do both or the renderer's "do not double-toast" rule is untested.
     */
    simulateSupervisor(action = 'restarting', appId = 'pulsenx', artifactId = 'appimage-linux') {
      const app = state.apps.find((a) => a.id === appId);
      if (!app) return null;
      const attempt = action === 'gave-up' ? 5 : 1 + Math.floor(Math.random() * 3);
      const ev = {
        type: 'supervisor',
        appId,
        appName: app.name,
        artifactId,
        action,
        attempt,
        ...(action === 'restarting' ? { delayMs: 2000 * attempt } : {}),
      };
      emit(ev);
      if (action === 'gave-up') {
        emit({
          type: 'toast',
          level: 'error',
          message: `${app.name} kept exiting — the watchdog stopped restarting it after ${attempt} attempts`,
        });
      }
      record({
        type: 'supervisor',
        appId,
        artifactId,
        summary:
          action === 'gave-up'
            ? `${app.name} kept exiting — the watchdog gave up after ${attempt} attempts`
            : `${app.name} exited unexpectedly — restarting (attempt ${attempt})`,
        data: { action, attempt },
      });
      return ev;
    },

    /** Flip the strict-signature setting so the unsigned markers light up. */
    toggleRequireSignatures() {
      state.settings.requireSignatures = !state.settings.requireSignatures;
      changed();
      emit({
        type: 'toast',
        level: 'info',
        message: state.settings.requireSignatures
          ? 'Signed releases are now required — unsigned assets from trusted publishers are refused'
          : 'Unsigned assets from trusted publishers are allowed again',
      });
      return state.settings.requireSignatures;
    },

    /** Flip keepAlive on an app, the way the options sheet would. */
    toggleKeepAlive(appId = 'pulsenx') {
      const app = state.apps.find((a) => a.id === appId);
      if (!app) return null;
      app.keepAlive = !app.keepAlive;
      const prefs = state.settings.appPrefs || (state.settings.appPrefs = {});
      prefs[appId] = { ...(prefs[appId] || {}), keepAlive: app.keepAlive };
      changed();
      return app.keepAlive;
    },

    /**
     * Put an artifact one version back with a matching pre-update snapshot —
     * the shortest route to the rollback-affinity checkbox from any state.
     *
     * `snapshot: false` arms the same rollback with NOTHING to offer, which is
     * the other half of the matrix: that path must still use a plain confirm.
     */
    armRollback(appId = 'quadforge', artifactId = 'blender-addon-linux', from = '0.9.0', to = '0.8.0', opts = {}) {
      const { art } = find(appId, artifactId);
      if (!art) return null;
      art.installed = { version: from, path: `/home/nerdrx/Applications/nx/${appId}/${artifactId}`, installedAt: new Date().toISOString() };
      art.prevVersion = to;
      art.rollbackAvailable = true;
      if (opts.snapshot !== false) pushSnapshot(appId, to, 'pre-update');
      recompute(state.apps, state.settings);
      changed();
      return { from, to };
    },

    /* -------------------------------------------------------- v0.7 helpers */

    /** The cross-hub stack: wake NX-WIN, gate its helper's port, then go local. */
    runPeeredStack(stackId = 'vr-night-both-machines') {
      return runStackSim(stackId);
    },
    /** Send the magic packets to the one peer that is asleep and addressable. */
    wakeMockPeer(peerId = 'c0ffee11deadbeef') {
      return wakePeer(peerId);
    },
    /** Put NX-WIN back to sleep so the Wake button comes back. */
    sleepMockPeer(peerId = 'c0ffee11deadbeef') {
      const p = findPeer(peerId);
      if (!p) return false;
      p.online = false;
      p.lastSeen = new Date().toISOString();
      fleetChanged();
      emit({ type: 'toast', level: 'warn', message: `${p.name} went to sleep` });
      return true;
    },
    /** A download served by a hub on this network instead of GitHub. */
    simulateLanJob(appId = 'quadforge', artifactId = 'blender-addon-linux', peer = 'workshop-pc') {
      return runJob(appId, artifactId, { lan: peer });
    },
    /**
     * The regex trap, on purpose: an app whose NAME contains LAN must not light
     * the chip. Its messages never carry the "(LAN)" marker.
     */
    simulateLanNameJob(appId = 'quadforge', artifactId = 'blender-addon-linux') {
      return runJob(appId, artifactId, { target: 'LAN party 3.0' });
    },
    devLinks() {
      return JSON.parse(JSON.stringify(devLinks));
    },
    /** Add a dev link back after unlinking it, so the tile can be re-reached. */
    relinkDev() {
      const have = new Set(devLinks.map((l) => l.appId));
      let added = 0;
      for (const l of DEV_SEED()) {
        if (!have.has(l.appId)) {
          devLinks.push(l);
          added += 1;
        }
      }
      emit({ type: 'dev-links-changed' });
      emit({ type: 'toast', level: 'info', message: `${added} dev link${added === 1 ? '' : 's'} restored` });
      return added;
    },
    /**
     * Move the folder out from under a link, or put it back — the broken tile
     * is a state the user WILL hit (a checkout gets moved) and the only way to
     * see it is to reach it here.
     */
    toggleDevExists(appId = 'nx-sandbox') {
      const link = devLinks.find((l) => l.appId === appId);
      if (!link) return null;
      link.exists = !link.exists;
      emit({ type: 'dev-links-changed' });
      emit({
        type: 'toast',
        level: link.exists ? 'info' : 'warn',
        message: link.exists ? `${link.name} found again` : `${link.name}: ${link.path} is gone`,
      });
      return link.exists;
    },
    /* -------------------------------------------------------- v0.10 helpers */

    /**
     * Take a peer's relayed roster away, or give it back, WITHOUT touching
     * whether the peer is online — the two are separate in main (a session can
     * be up before the first bus-roster arrives) and the UI has to survive both.
     */
    toggleRemoteRoster(peerId = 'a1b2c3d4e5f60718') {
      const peer = findPeer(peerId);
      if (!peer) return null;
      const had = (state.connector.remote || []).some((r) => r.peerId === peerId);
      if (had) {
        state.connector.remote = (state.connector.remote || []).filter((r) => r.peerId !== peerId);
      } else if (remoteRosters[peerId]) {
        state.connector.remote = [
          ...(state.connector.remote || []),
          { peerId, peerName: peer.name, clients: remoteRosters[peerId]() },
        ];
      }
      busChanged();
      emit({
        type: 'toast',
        level: had ? 'warn' : 'info',
        message: had ? `${peer.name} stopped relaying its bus` : `${peer.name} is relaying its bus`,
      });
      return !had;
    },

    /** Bring NX-WIN up WITH its roster — the "wivrn on NX-WIN" state in one click. */
    relayNxWin(peerId = 'c0ffee11deadbeef') {
      const p = findPeer(peerId);
      if (!p) return null;
      p.online = true;
      p.lastSeen = new Date().toISOString();
      fleetChanged();
      emit({ type: 'toast', level: 'info', message: `${p.name} is on the network and relaying its bus` });
      return JSON.parse(JSON.stringify(state.connector.remote));
    },

    /** The plan, without going through the sheet — for tests and screenshots. */
    checkpoint(when = Date.now() - 3600000) {
      return JSON.parse(JSON.stringify(checkpointPlan(when)));
    },

    /** Run the restore simulation directly (the sheet does the same thing). */
    runCheckpoint(when = Date.now() - 3600000, opts = {}) {
      return restoreCheckpointSim(when, opts);
    },

    /** Arm (or disarm) the failure ending of the next restore. */
    toggleCheckpointFailure() {
      checkpointFails = !checkpointFails;
      emit({
        type: 'toast',
        level: checkpointFails ? 'warn' : 'info',
        message: checkpointFails
          ? 'The next checkpoint restore will stop partway'
          : 'Checkpoint restores will run to the end again',
      });
      return checkpointFails;
    },

    audit() {
      return JSON.parse(JSON.stringify(auditRows));
    },

    /** Put the two broken installs back after a repair fixed them. */
    breakInstalls() {
      auditRows = AUDIT_SEED();
      emit({ type: 'toast', level: 'warn', message: 'Two installs are damaged again' });
      return auditRows.filter((r) => !r.ok).length;
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
    <button class="btn btn-ghost btn-sm" data-mock="delta">simulate delta update</button>
    <button class="btn btn-ghost btn-sm" data-mock="peered-stack">run cross-hub stack</button>
    <button class="btn btn-ghost btn-sm" data-mock="wake">wake NX-WIN</button>
    <button class="btn btn-ghost btn-sm" data-mock="sleep">put NX-WIN to sleep</button>
    <button class="btn btn-ghost btn-sm" data-mock="lan">simulate LAN download</button>
    <button class="btn btn-ghost btn-sm" data-mock="lan-name">simulate "LAN party" download</button>
    <button class="btn btn-ghost btn-sm" data-mock="relink">restore dev links</button>
    <button class="btn btn-ghost btn-sm" data-mock="dev-gone">toggle dev folder missing</button>
    <button class="btn btn-ghost btn-sm" data-mock="sig">toggle require signatures</button>
    <button class="btn btn-ghost btn-sm" data-mock="keepalive">toggle keep alive (PulseNX)</button>
    <button class="btn btn-ghost btn-sm" data-mock="restarting">watchdog: restarting</button>
    <button class="btn btn-ghost btn-sm" data-mock="gave-up">watchdog: gave up</button>
    <button class="btn btn-ghost btn-sm" data-mock="arm-rollback">arm rollback + config snapshot</button>
    <button class="btn btn-ghost btn-sm" data-mock="log-event">record a live event</button>
    <button class="btn btn-ghost btn-sm" data-mock="relay">NX-WIN relays its bus</button>
    <button class="btn btn-ghost btn-sm" data-mock="roster">toggle relayed roster</button>
    <button class="btn btn-ghost btn-sm" data-mock="checkpoint">run checkpoint restore</button>
    <button class="btn btn-ghost btn-sm" data-mock="checkpoint-configs">checkpoint restore + configs</button>
    <button class="btn btn-ghost btn-sm" data-mock="checkpoint-fail">toggle checkpoint failure</button>
    <button class="btn btn-ghost btn-sm" data-mock="break">damage two installs</button>`;
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
    else if (what === 'peered-stack') dev.runPeeredStack();
    else if (what === 'wake') dev.wakeMockPeer();
    else if (what === 'sleep') dev.sleepMockPeer();
    else if (what === 'lan') dev.simulateLanJob();
    else if (what === 'lan-name') dev.simulateLanNameJob();
    else if (what === 'relink') dev.relinkDev();
    else if (what === 'dev-gone') dev.toggleDevExists();
    else if (what === 'sig') dev.toggleRequireSignatures();
    else if (what === 'keepalive') dev.toggleKeepAlive();
    else if (what === 'restarting') dev.simulateSupervisor('restarting');
    else if (what === 'gave-up') dev.simulateSupervisor('gave-up');
    else if (what === 'arm-rollback') dev.armRollback();
    else if (what === 'log-event') dev.logEvent();
    else if (what === 'relay') dev.relayNxWin();
    else if (what === 'roster') dev.toggleRemoteRoster();
    else if (what === 'checkpoint') dev.runCheckpoint();
    else if (what === 'checkpoint-configs') dev.runCheckpoint(Date.now() - 3600000, { configs: true });
    else if (what === 'checkpoint-fail') dev.toggleCheckpointFailure();
    else if (what === 'break') dev.breakInstalls();
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
