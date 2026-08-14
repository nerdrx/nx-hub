// Tiny HTML string helpers. Everything the UI renders goes through here so that
// escaping is the default and "raw" is an explicit, greppable opt-in.

/** Escape a value for use in HTML text or a quoted attribute. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RAW = Symbol('raw-html');

/** Mark a string as already-safe HTML (skips escaping when interpolated). */
export function raw(str) {
  return { [RAW]: true, value: str === null || str === undefined ? '' : String(str) };
}

export function isRaw(v) {
  return !!(v && typeof v === 'object' && v[RAW] === true);
}

function interpolate(v) {
  if (v === null || v === undefined || v === false) return '';
  if (isRaw(v)) return v.value;
  if (Array.isArray(v)) return v.map(interpolate).join('');
  return esc(v);
}

/**
 * html`<div>${untrusted}</div>` — escapes every interpolation unless wrapped in
 * raw(). Returns a plain string (renderers stay pure and unit-testable).
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += interpolate(values[i]);
  }
  return out;
}

/** Join truthy class names. */
export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/** Build an attribute string from a plain object, skipping null/false values. */
export function attrs(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (v === true) out.push(esc(k));
    else out.push(`${esc(k)}="${esc(v)}"`);
  }
  return out.join(' ');
}
