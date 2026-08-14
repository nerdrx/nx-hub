// Inline SVG icon set. Plain strings — no runtime, no sprite sheet, no fetch.

export const logo = (size = 34) => `
<svg class="logo" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="nxhex" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9a3cff"/>
      <stop offset="1" stop-color="#5c00c8"/>
    </linearGradient>
    <filter id="nxglow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="2.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g filter="url(#nxglow)">
    <path d="M32 3 L56 17 L56 47 L32 61 L8 47 L8 17 Z" fill="url(#nxhex)" stroke="#00e5ff" stroke-width="2.2" stroke-linejoin="round"/>
  </g>
  <path d="M32 3 L56 17 L56 47 L32 61 L8 47 L8 17 Z" fill="none" stroke="#00e5ff" stroke-opacity=".55" stroke-width="1"/>
  <text x="32" y="40" text-anchor="middle" font-family="system-ui, sans-serif" font-size="21" font-weight="700" fill="#efeaff" letter-spacing="0.5">NX</text>
</svg>`;

export const refresh = `
<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/>
</svg>`;

export const gear = `
<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">
  <circle cx="12" cy="12" r="3.2"/>
  <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" stroke-linecap="round"/>
</svg>`;

export const lock = `
<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">
  <rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>
</svg>`;

export const chevron = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
  <path d="m7 10 5 5 5-5"/>
</svg>`;

export const dots = `
<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
  <circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>
</svg>`;

export const copy = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9">
  <rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>
</svg>`;

export const close = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
  <path d="M6 6l12 12M18 6 6 18"/>
</svg>`;

export const external = `
<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>
</svg>`;

export const plug = `
<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
  <path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 17v4"/>
</svg>`;

export const star = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
  <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/>
</svg>`;

export const starFilled = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
  <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/>
</svg>`;

export const history = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M3.6 9.5A8.5 8.5 0 1 1 3 12"/><path d="M3 4.5V10h5.5"/><path d="M12 7.5V12l3 1.8"/>
</svg>`;

export const sliders = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>
</svg>`;

export const eyeOff = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
  <path d="M3 3l18 18"/><path d="M10.6 6.3A9.7 9.7 0 0 1 12 6.2c5 0 9 5.8 9 5.8a17 17 0 0 1-3 3.5"/>
  <path d="M6.2 8.2A17.6 17.6 0 0 0 3 12s4 5.8 9 5.8a9 9 0 0 0 3.4-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>
</svg>`;

export const eye = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
  <path d="M3 12s4-5.8 9-5.8S21 12 21 12s-4 5.8-9 5.8S3 12 3 12z"/><circle cx="12" cy="12" r="2.6"/>
</svg>`;

export const disk = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9">
  <ellipse cx="12" cy="6.4" rx="7.5" ry="3"/><path d="M4.5 6.4v11.2c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6.4"/>
  <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>
</svg>`;

export const terminal = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 10 2.6 2.4-2.6 2.4M13 15h3.5"/>
</svg>`;

export const download = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M12 4v10"/><path d="m8 10.5 4 4 4-4"/><path d="M5 19h14"/>
</svg>`;

export const upload = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M12 15V5"/><path d="m8 8.5 4-4 4 4"/><path d="M5 19h14"/>
</svg>`;

export const battery = `
<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8">
  <rect x="2.5" y="8" width="16" height="8" rx="2.2"/><path d="M21 11v2" stroke-linecap="round"/>
</svg>`;

export const rollback = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M4 10h9a5 5 0 0 1 0 10H8"/><path d="m8 6-4 4 4 4"/>
</svg>`;

export const trash = `
<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
  <path d="M4.5 7h15"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/>
  <path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>
</svg>`;

export const search = `
<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <circle cx="11" cy="11" r="6"/><path d="m20 20-3.6-3.6"/>
</svg>`;
