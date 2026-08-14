// adb devices: the header status chip, the devices sheet (pick a device, connect
// over Wi-Fi, read battery/storage) and the one-line summary shown on APK rows.

import { esc } from '../lib/html.js';
import { formatBytes } from '../lib/version.js';
import { batteryLevel, deviceChipLabel, deviceSummary, normalizeDeviceInfo, selectedSerial } from '../lib/devices.js';
import { renderSheet } from './sheet.js';
import * as icons from './icons.js';

/** Header chip — click opens the devices sheet. */
export function renderDeviceChip(adb, info, ctx = {}) {
  const devices = (adb && adb.devices) || [];
  const online = devices.filter((d) => d && d.state === 'device');
  const state = online.length ? 'on' : devices.length ? 'off' : 'none';
  const d = normalizeDeviceInfo(info);
  const battery = online.length && d && d.batteryPct !== null ? batteryLevel(d.batteryPct) : '';

  return `<button class="dev-chip dev-${esc(state)}" data-act="devices" title="${esc(
    online.length ? 'Connected device — click to manage' : 'No adb device — click to connect'
  )}" aria-label="Devices">
      <span class="dev-dot" aria-hidden="true"></span>
      ${icons.plug}<span class="dev-chip-text">${esc(deviceChipLabel(adb, info))}</span>
      ${battery ? `<span class="dev-batt batt-${esc(battery)}">${esc(String(d.batteryPct))}%</span>` : ''}
      ${ctx.busy ? '<span class="spinner spinner-sm" aria-hidden="true"></span>' : ''}
    </button>`;
}

/** The line shown on apk-adb rows so the target is obvious before installing. */
export function renderDeviceLine(info, ctx = {}) {
  const summary = deviceSummary(info);
  if (!summary) return '';
  const d = normalizeDeviceInfo(info);
  const level = d && d.batteryPct !== null ? batteryLevel(d.batteryPct) : '';
  return `<div class="dev-line${level === 'low' ? ' dev-line-low' : ''}"${
    ctx.title ? ` title="${esc(ctx.title)}"` : ''
  }>${icons.battery}<span>${esc(summary)}</span></div>`;
}

function deviceRow(device, selected) {
  const online = device.state === 'device';
  const id = `dev-${device.serial || device.model}`;
  return `
    <label class="dev-row${online ? '' : ' is-off'}" for="${esc(id)}">
      <input id="${esc(id)}" type="radio" name="adb-device" data-act="select-device"
             data-serial="${esc(device.serial)}"${selected ? ' checked' : ''}${online ? '' : ' disabled'}>
      <span class="radio-dot" aria-hidden="true"></span>
      <span class="dev-row-main">
        <span class="dev-row-name">${esc(device.model || device.serial || 'Android device')}</span>
        <span class="dev-row-serial">${esc(device.serial || 'unknown serial')}${online ? '' : ` · ${esc(device.state || 'offline')}`}</span>
      </span>
    </label>`;
}

/**
 * @param {object} state normalized hub state (adb + settings)
 * @param {object} ctx   { info, connecting, error, infoError, caps }
 */
export function renderDevicesSheet(state, ctx = {}) {
  const adb = state.adb || { devices: [] };
  const devices = adb.devices || [];
  const caps = ctx.caps || {};
  const selected = selectedSerial(adb, state.settings);
  const info = normalizeDeviceInfo(ctx.info);

  const list = devices.length
    ? devices.map((d) => deviceRow(d, d.serial === selected)).join('')
    : `<p class="sheet-empty">No device. Plug the headset in with USB debugging enabled, or connect over Wi-Fi below.</p>`;

  const wireless =
    caps.adbConnect === false
      ? ''
      : `
      <section class="fieldset">
        <h3>Connect over Wi-Fi</h3>
        <label class="lbl" for="dev-host">Headset address — <code>host</code> or <code>host:port</code> (default 5555)</label>
        <div class="row">
          <input id="dev-host" class="input mono${ctx.error ? ' invalid' : ''}" type="text" spellcheck="false"
                 autocomplete="off" placeholder="192.168.1.42:5555" data-field="adbHost" value="${esc(ctx.host || '')}">
          <button class="btn btn-violet btn-sm" data-act="adb-connect"${ctx.connecting ? ' disabled' : ''}>${
            ctx.connecting ? 'Connecting…' : 'Connect'
          }</button>
        </div>
        ${ctx.error ? `<p class="field-error">${esc(ctx.error)}</p>` : ''}
        ${ctx.connected ? `<p class="field-ok">${esc(ctx.connected)}</p>` : ''}
      </section>`;

  const infoSection =
    caps.getDeviceInfo === false
      ? ''
      : `
      <section class="fieldset">
        <h3>Device</h3>
        ${
          info
            ? `<div class="dev-facts">
                 <div class="fact"><span class="fact-k">Model</span><span class="fact-v">${esc(info.model)}</span></div>
                 <div class="fact"><span class="fact-k">Serial</span><span class="fact-v mono">${esc(info.serial || 'unknown')}</span></div>
                 <div class="fact"><span class="fact-k">Battery</span><span class="fact-v batt-${esc(
                   batteryLevel(info.batteryPct)
                 )}">${info.batteryPct === null ? 'unknown' : `${esc(String(info.batteryPct))}%`}</span></div>
                 <div class="fact"><span class="fact-k">Free storage</span><span class="fact-v">${esc(
                   info.storageFreeBytes ? formatBytes(info.storageFreeBytes) : 'unknown'
                 )}</span></div>
               </div>`
            : `<p class="field-note">${esc(ctx.infoError || 'No device details yet.')}</p>`
        }
        <button class="btn btn-ghost btn-sm" data-act="device-info">${icons.refresh}<span>Refresh</span></button>
      </section>`;

  const body = `
    <section class="fieldset">
      <h3>Devices</h3>
      ${list}
      ${adb.error ? `<p class="field-error">${esc(adb.error)}</p>` : ''}
      <p class="field-note">The selected device receives every APK install and <code>adb</code> launch.</p>
    </section>
    ${wireless}
    ${infoSection}`;

  return renderSheet({
    title: 'Devices',
    subtitle: 'adb targets for APK artifacts',
    label: 'Devices',
    body,
  });
}
