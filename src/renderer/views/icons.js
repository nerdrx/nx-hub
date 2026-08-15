// Inline SVG icon set. Plain strings — no runtime, no sprite sheet, no fetch.

// The header mark: the same crystal as assets/icon.svg, reduced to what still
// lands on a pixel at 34px. Dropped: the blurred bloom, the well's seam ring,
// the specular cap on the letters, and the cyan nebula (folded into the well's
// own radial). Ids are prefixed nxl so they cannot collide with app markup.

export const logo = (size = 34) => `
<svg class="logo" width="${size}" height="${size}" viewBox="0 0 512 512" aria-hidden="true">
  <defs><linearGradient id="nxll" x1="0" y1="0" x2=".25" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#f2ebff"/><stop offset="1" stop-color="#b98cff"/></linearGradient><radialGradient id="nxlw" cx=".42" cy=".34" r=".8"><stop offset="0" stop-color="#3d1c73"/><stop offset=".62" stop-color="#1a1038"/><stop offset="1" stop-color="#0e0a1e"/></radialGradient><linearGradient id="nxlr" gradientUnits="userSpaceOnUse" x1="80" y1="61.7" x2="432" y2="352.6"><stop offset="0" stop-color="#00e5ff" stop-opacity=".9"/><stop offset="1" stop-color="#00e5ff" stop-opacity="0"/></linearGradient><linearGradient id="nxle" x1=".1" y1="0" x2=".9" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".8"/><stop offset=".45" stop-color="#e6d2ff" stop-opacity=".15"/><stop offset="1" stop-color="#fff" stop-opacity=".05"/></linearGradient><clipPath id="nxlt"><rect x="0" y="201" width="512" height="110"/></clipPath></defs>
  <path d="M256,29.3Q265.6,29.3 275.2,34.7L445.8,129.3Q455.4,134.7 460.2,142.8L429.6,160.8Q427.2,156.8 422.4,154.1L265.6,67.1Q260.8,64.4 256,64.4Z" fill="#914af7"/><path d="M460.2,142.8Q465,151 465,162L465,350Q465,361 460.2,369.2L429.6,351.2Q432,347.1 432,341.6L432,170.4Q432,164.9 429.6,160.8Z" fill="#4c13aa"/><path d="M460.2,369.2Q455.4,377.3 445.8,382.7L275.2,477.3Q265.6,482.7 256,482.7L256,447.6Q260.8,447.6 265.6,444.9L422.4,357.9Q427.2,355.2 429.6,351.2Z" fill="#350f78"/><path d="M256,482.7Q246.4,482.7 236.8,477.3L66.2,382.7Q56.6,377.3 51.8,369.2L82.4,351.2Q84.8,355.2 89.6,357.9L246.4,444.9Q251.2,447.6 256,447.6Z" fill="#4c13a9"/><path d="M51.8,369.2Q47,361 47,350L47,162Q47,151 51.8,142.8L82.4,160.8Q80,164.9 80,170.4L80,341.6Q80,347.1 82.4,351.2Z" fill="#9048f7"/><path d="M51.8,142.8Q56.6,134.7 66.2,129.3L236.8,34.7Q246.4,29.3 256,29.3L256,64.4Q251.2,64.4 246.4,67.1L89.6,154.1Q84.8,156.8 82.4,160.8Z" fill="#b585f5"/><path d="M246.4,67.1Q256,61.7 265.6,67.1L422.4,154.1Q432,159.4 432,170.4L432,341.6Q432,352.6 422.4,357.9L265.6,444.9Q256,450.3 246.4,444.9L89.6,357.9Q80,352.6 80,341.6L80,170.4Q80,159.4 89.6,154.1Z" fill="url(#nxlw)"/><g fill="url(#nxlr)"><path d="M82.4,160.8Q84.8,156.8 89.6,154.1L246.4,67.1Q251.2,64.4 256,64.4L256,70.7Q254.3,70.7 252.5,71.7L90.5,161.6Q88.7,162.6 87.9,164.1Z"/><path d="M256,64.4Q260.8,64.4 265.6,67.1L422.4,154.1Q427.2,156.8 429.6,160.8L424.1,164.1Q423.3,162.6 421.5,161.6L259.5,71.7Q257.7,70.7 256,70.7Z"/></g><path d="M236.8,34.7Q256,24 275.2,34.7L445.8,129.3Q465,140 465,162L465,350Q465,372 445.8,382.7L275.2,477.3Q256,488 236.8,477.3L66.2,382.7Q47,372 47,350L47,162Q47,140 66.2,129.3ZM240.7,37.6Q256,29.1 271.3,37.6L445.2,134.2Q460.5,142.6 460.5,160.1L460.5,351.9Q460.5,369.4 445.2,377.8L271.3,474.4Q256,482.9 240.7,474.4L66.8,377.8Q51.5,369.4 51.5,351.9L51.5,160.1Q51.5,142.6 66.8,134.2Z" fill-rule="evenodd" fill="url(#nxle)"/><g clip-path="url(#nxlt)" fill="none" stroke-linejoin="miter" stroke-miterlimit="4"><path d="M162.2,357L162.2,201L232.2,311L232.2,155 M252.8,162.2L372.2,349.8M372.2,162.2L252.8,349.8" stroke="#00e5ff" stroke-width="28" opacity=".85"/><path d="M162.2,357L162.2,201L232.2,311L232.2,155 M252.8,162.2L372.2,349.8M372.2,162.2L252.8,349.8" stroke="url(#nxll)" stroke-width="25" transform="translate(0,-1.6)"/></g>
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
