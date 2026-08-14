// The action-button state matrix for one artifact row. Pure data in → data out
// so the whole matrix is unit-testable without a DOM.

const NON_LAUNCHABLE_KINDS = new Set(['blender-addon', 'generic-zip']);

/** Best-effort host platform detection ('linux' | 'win32' | 'darwin'). */
export function detectPlatform(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
  const s = `${(n && n.userAgentData && n.userAgentData.platform) || ''} ${(n && n.platform) || ''} ${(n && n.userAgent) || ''}`.toLowerCase();
  if (s.includes('win')) return 'win32';
  if (s.includes('mac') || s.includes('darwin')) return 'darwin';
  return 'linux';
}

export function isLaunchable(artifact) {
  if (!artifact) return false;
  if (artifact.launchable === false) return false;
  return !NON_LAUNCHABLE_KINDS.has(artifact.kind);
}

/**
 * @param {object} app        normalized app
 * @param {object} artifact   normalized artifact
 * @param {object} ctx        { platform, adb, job }
 * @returns {{buttons:Array, menu:Array|null, hint:string, busy:boolean}}
 */
export function artifactActions(app, artifact, ctx = {}) {
  const platform = ctx.platform || 'linux';
  const adb = ctx.adb || { connected: false, devices: [] };
  const busy = !!ctx.job;
  const installed = !!(artifact && artifact.installed);
  const menu = [];
  let hint = '';

  const result = (buttons, extra = {}) => ({
    buttons,
    menu: menu.length ? menu : null,
    hint,
    busy,
    ...extra,
  });

  if (!artifact) return result([]);

  menu.push({ act: 'github', label: 'Open GitHub page' });
  if (installed) {
    menu.unshift({ act: 'uninstall', label: 'Uninstall', danger: true });
    if (artifact.installed.path && artifact.platform !== 'android') {
      menu.splice(1, 0, { act: 'folder', label: 'Show in folder' });
    }
  }

  // Windows artifacts are visible but not installable from a Linux host.
  if (artifact.platform === 'windows' && platform !== 'win32') {
    return result([
      {
        act: 'install',
        label: 'Install',
        variant: 'violet',
        disabled: true,
        title: 'install from the hub on Windows',
      },
    ]);
  }

  // Android artifacts need a connected adb device.
  const needsDevice = artifact.kind === 'apk-adb';
  const deviceMissing = needsDevice && !adb.connected;
  if (needsDevice) {
    if (adb.connected) {
      const d = adb.devices[0];
      hint = d ? `${d.model}${d.serial ? ` (${d.serial})` : ''} connected` : 'device connected';
    } else {
      hint = 'no headset connected — plug it in and enable USB debugging';
    }
  }

  const blockedTitle = busy
    ? `a job is already running for ${app && app.name ? app.name : 'this app'}`
    : deviceMissing
      ? 'no headset connected'
      : '';

  if (!installed) {
    return result([
      {
        act: 'install',
        label: 'Install',
        variant: 'violet',
        disabled: busy || deviceMissing,
        title: blockedTitle,
      },
    ]);
  }

  const launchBtn = (variant) => ({
    act: 'launch',
    label: 'Launch',
    variant,
    disabled: busy || deviceMissing,
    title: blockedTitle,
  });

  if (artifact.updateAvailable) {
    const buttons = [
      {
        act: 'install',
        label: 'Update',
        variant: 'amber',
        disabled: busy || deviceMissing,
        title: blockedTitle,
      },
    ];
    if (isLaunchable(artifact)) buttons.push(launchBtn('ghost'));
    return result(buttons, { update: true });
  }

  const buttons = [];
  if (isLaunchable(artifact)) buttons.push(launchBtn('outline'));
  return result(buttons, { current: true });
}

/** Short chip text per platform. */
export function platformLabel(platform) {
  if (platform === 'android') return 'android';
  if (platform === 'windows') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}
