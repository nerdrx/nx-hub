// adb device model: the device list, the wireless-connect input and the
// one-line summary shown before an APK install ("Pico 4 · 82% · 12.4 GB free").
//
// Locale-independent by construction — no toLocaleString anywhere (the host may
// run de_DE; SPEC keeps the UI English).

import { formatBytes } from './version.js';

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

export function normalizeDeviceInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const battery = Number(info.batteryPct);
  const free = Number(info.storageFreeBytes);
  const serial = str(info.serial);
  const model = str(info.model) || serial || 'Android device';
  return {
    serial,
    model,
    batteryPct: Number.isFinite(battery) ? Math.max(0, Math.min(100, Math.round(battery))) : null,
    storageFreeBytes: Number.isFinite(free) && free > 0 ? free : 0,
  };
}

/** "Pico 4 Ultra · 82% · 12.4 GB free" — parts drop out when unknown. */
export function deviceSummary(info) {
  const d = normalizeDeviceInfo(info);
  if (!d) return '';
  const parts = [d.model];
  if (d.batteryPct !== null) parts.push(`${d.batteryPct}%`);
  if (d.storageFreeBytes) parts.push(`${formatBytes(d.storageFreeBytes)} free`);
  return parts.join(' · ');
}

/** Battery styling bucket for the chip: low ≤ 20, warn ≤ 40, else ok. */
export function batteryLevel(pct) {
  if (pct === null || pct === undefined || pct === '') return '';
  const n = Number(pct);
  if (!Number.isFinite(n)) return '';
  if (n <= 20) return 'low';
  if (n <= 40) return 'warn';
  return 'ok';
}

/** Which device the hub will talk to: the pinned serial, else the first online. */
export function selectedSerial(adb, settings) {
  const devices = (adb && adb.devices) || [];
  const pinned = str(settings && settings.preferredDeviceSerial).trim();
  if (pinned && devices.some((d) => d && d.serial === pinned)) return pinned;
  const online = devices.find((d) => d && d.state === 'device');
  return (online && online.serial) || (devices[0] && devices[0].serial) || '';
}

/** Short status text for the header chip. */
export function deviceChipLabel(adb, info) {
  const devices = (adb && adb.devices) || [];
  if (!devices.length) return 'No device';
  const online = devices.filter((d) => d && d.state === 'device');
  if (!online.length) return `${devices.length} offline`;
  const d = normalizeDeviceInfo(info);
  if (d && d.model && online.some((x) => !x.serial || !d.serial || x.serial === d.serial)) {
    return d.batteryPct !== null ? `${d.model} · ${d.batteryPct}%` : d.model;
  }
  if (online.length > 1) return `${online.length} devices`;
  return online[0].model || online[0].serial || 'Device';
}

/**
 * host[:port] for `adb connect`. Empty port defaults to 5555 (the adb default),
 * which is what the Pico exposes over Wi-Fi debugging.
 */
export function parseHostPort(value) {
  const raw = str(value).trim();
  if (!raw) return { ok: false, hostPort: '', error: 'Enter the headset address, e.g. 192.168.1.42:5555.' };
  let host = raw;
  let port = '5555';
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw); // [ipv6]:port
  if (m) {
    host = m[1];
    port = m[2] || port;
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx > 0 && !raw.slice(idx + 1).includes(':')) {
      host = raw.slice(0, idx);
      port = raw.slice(idx + 1);
    }
  }
  if (!host || /\s/.test(host)) return { ok: false, hostPort: '', error: `“${raw}” is not a valid address.` };
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return { ok: false, hostPort: '', error: `“${raw}” is not a valid address.` };
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return { ok: false, hostPort: '', error: `“${port}” is not a valid port.` };
  }
  return { ok: true, hostPort: `${host.includes(':') ? `[${host}]` : host}:${port}`, error: '' };
}
