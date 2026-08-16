// Stacks — the model, the editor draft, and the progress state machine.
//
// SPEC v0.5 freezes the stack model as
//   { id, name, steps:[{ appId, artifactId?,
//                        health:{ type:"connector"|"port"|"delay", timeoutMs?, port? },
//                        optional? }] }
// and the run events as { stackId, stepIndex, appId, phase } with phase ∈
// launching|waiting|healthy|failed|done|stopping|stopped.
//
// Everything here is pure: no DOM, no bridge calls, so the tile glyph machine
// and the editor validation are unit-testable on their own.

import { isLaunchable } from './actions.js';
import { monogram, tileHue } from './launcher.js';

export const HEALTH_TYPES = ['connector', 'port', 'delay'];
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_DELAY_MS = 2000;
export const MAX_TIMEOUT_MS = 600000;

/**
 * v0.6 automation. SPEC: `trigger: { type: "adb-device"|"connector-app",
 * serial?, appId?, stopOnLeave?: bool, cooldownMs?: 60000 }` — absent means the
 * stack only ever runs when somebody presses Run.
 */
export const TRIGGER_TYPES = ['adb-device', 'connector-app'];
export const DEFAULT_COOLDOWN_MS = 60000;
export const MIN_COOLDOWN_S = 5;
export const MAX_COOLDOWN_S = 3600;

// v0.6: the trigger watcher announces itself with `triggered` (stepIndex null,
// reason = the trigger type) BEFORE the first `launching` — it is the opening
// state of a run nobody clicked.
export const PHASES = ['triggered', 'launching', 'waiting', 'healthy', 'failed', 'done', 'stopping', 'stopped'];
const TERMINAL = new Set(['done', 'failed', 'stopped']);

/** How long a finished run stays on its tile before the tile goes quiet. */
export const CLEAR_AFTER_MS = 4000;

const GLYPHS = {
  triggered: '↯',
  launching: '▸',
  waiting: '◌',
  healthy: '✓',
  done: '✓',
  failed: '✕',
  stopping: '◌',
  stopped: '·',
};

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

/** "VR Night" → "vr-night". ASCII-only and locale-independent by design. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

export function normalizeHealth(raw) {
  const h = raw && typeof raw === 'object' ? raw : {};
  const type = HEALTH_TYPES.includes(h.type) ? h.type : 'connector';
  const out = { type };
  const timeout = Math.round(Number(h.timeoutMs));
  if (Number.isFinite(timeout) && timeout > 0) out.timeoutMs = timeout;
  if (type === 'port') {
    const port = Math.round(Number(h.port));
    if (Number.isFinite(port) && port > 0) out.port = port;
  }
  return out;
}

export function normalizeStep(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const step = {
    appId: String(s.appId || '').trim().toLowerCase(),
    health: normalizeHealth(s.health),
  };
  if (s.artifactId) step.artifactId = String(s.artifactId);
  if (s.optional) step.optional = true;
  return step;
}

/**
 * A trigger, or null for "Manual".
 *
 * A `connector-app` trigger with no app id could never fire, so it degrades to
 * Manual rather than pretending the stack is automated — the editor refuses to
 * save that shape in the first place.
 */
export function normalizeTrigger(raw) {
  const t = raw && typeof raw === 'object' ? raw : null;
  if (!t || !TRIGGER_TYPES.includes(t.type)) return null;
  const out = { type: t.type };
  if (t.type === 'adb-device') {
    const serial = String(t.serial || '').trim();
    if (serial) out.serial = serial;
  } else {
    // Verbatim (trimmed only): [triggers] matches the bus id as it was written,
    // and never slugifies it. Lower-casing happens at LOOKUP time, not here.
    const appId = String(t.appId || '').trim();
    if (!appId) return null;
    out.appId = appId;
  }
  if (t.stopOnLeave) out.stopOnLeave = true;
  const cooldown = Math.round(Number(t.cooldownMs));
  out.cooldownMs = Number.isFinite(cooldown) && cooldown > 0
    ? Math.max(MIN_COOLDOWN_S * 1000, Math.min(MAX_COOLDOWN_S * 1000, cooldown))
    : DEFAULT_COOLDOWN_MS;
  return out;
}

export function normalizeStack(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const name = String(s.name || '').trim();
  const id = String(s.id || '').trim() || slugify(name);
  const trigger = normalizeTrigger(s.trigger);
  const out = {
    id,
    name: name || id,
    steps: asArray(s.steps).map(normalizeStep).filter((st) => st.appId),
  };
  // Absent for Manual — the key never appears in what reaches saveStack().
  if (trigger) out.trigger = trigger;
  return out;
}

export function normalizeStacks(list) {
  return asArray(list)
    .map(normalizeStack)
    .filter((s) => s.id);
}

/* ------------------------------------------------------------------ editor */

export function blankStep() {
  return { appId: '', artifactId: '', healthType: 'connector', port: '', timeoutMs: '', optional: false };
}

/** Trigger fields of a blank draft — Manual, with the default cooldown shown. */
export function blankTriggerFields() {
  return {
    triggerType: '',
    triggerSerial: '',
    triggerAppId: '',
    triggerStopOnLeave: false,
    triggerCooldown: String(DEFAULT_COOLDOWN_MS / 1000),
  };
}

function triggerFieldsFrom(trigger) {
  if (!trigger) return blankTriggerFields();
  return {
    triggerType: trigger.type,
    triggerSerial: trigger.serial || '',
    triggerAppId: trigger.appId || '',
    triggerStopOnLeave: !!trigger.stopOnLeave,
    triggerCooldown: String(Math.round((trigger.cooldownMs || DEFAULT_COOLDOWN_MS) / 1000)),
  };
}

/** Stack → editor draft (every value a string, the way an input holds it). */
export function draftFromStack(stack) {
  const s = normalizeStack(stack);
  return {
    originalId: s.id,
    name: s.name,
    ...triggerFieldsFrom(s.trigger || null),
    steps: s.steps.length
      ? s.steps.map((st) => ({
          appId: st.appId,
          artifactId: st.artifactId || '',
          healthType: st.health.type,
          port: st.health.port ? String(st.health.port) : '',
          timeoutMs: st.health.timeoutMs ? String(st.health.timeoutMs) : '',
          optional: !!st.optional,
        }))
      : [blankStep()],
  };
}

export function blankDraft() {
  return { originalId: '', name: '', ...blankTriggerFields(), steps: [blankStep()] };
}

/** Editor draft → the trigger object (or null when the user picked Manual). */
export function triggerFromDraft(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  if (!TRIGGER_TYPES.includes(d.triggerType)) return null;
  const seconds = Number(String(d.triggerCooldown === undefined ? '' : d.triggerCooldown).trim());
  const raw = {
    type: d.triggerType,
    serial: d.triggerSerial,
    appId: d.triggerAppId,
    stopOnLeave: !!d.triggerStopOnLeave,
    cooldownMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : DEFAULT_COOLDOWN_MS,
  };
  return normalizeTrigger(raw);
}

/** Editor draft → the frozen stack model. Ids are slugified from the name. */
export function stackFromDraft(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const name = String(d.name || '').trim();
  const trigger = triggerFromDraft(d);
  return normalizeStack({
    id: slugify(name),
    name,
    ...(trigger ? { trigger } : {}),
    steps: asArray(d.steps).map((step) => {
      const s = step && typeof step === 'object' ? step : {};
      const type = HEALTH_TYPES.includes(s.healthType) ? s.healthType : 'connector';
      const health = { type };
      const timeout = Math.round(Number(s.timeoutMs));
      if (Number.isFinite(timeout) && timeout > 0) health.timeoutMs = timeout;
      if (type === 'port') {
        const port = Math.round(Number(s.port));
        if (Number.isFinite(port) && port > 0) health.port = port;
      }
      return { appId: s.appId, artifactId: s.artifactId || '', health, optional: !!s.optional };
    }),
  });
}

function numberish(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Client-side validation mirroring what main will accept.
 *
 * @param {object} draft   editor draft
 * @param {Array}  stacks  existing stacks (for the id-collision check)
 * @returns {{ok:boolean, errors:object, stack:object}}
 */
export function validateDraft(draft, stacks = []) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const errors = {};
  const name = String(d.name || '').trim();
  const id = slugify(name);

  if (!name) errors.name = 'Give the stack a name.';
  else if (!id) errors.name = 'That name has no letters or digits to build an id from.';
  else {
    const clash = normalizeStacks(stacks).find((s) => s.id === id && s.id !== d.originalId);
    if (clash) errors.name = `Another stack already uses the id “${id}” — pick a different name.`;
  }

  // Automation. Manual (no type) skips all of it.
  if (TRIGGER_TYPES.includes(d.triggerType)) {
    if (d.triggerType === 'connector-app' && !String(d.triggerAppId || '').trim()) {
      errors.triggerAppId = 'Pick the app whose arrival starts this stack.';
    }
    const serial = String(d.triggerSerial || '').trim();
    if (d.triggerType === 'adb-device' && serial && /\s/.test(serial)) {
      errors.triggerSerial = 'A device serial has no spaces — leave it empty to match any device.';
    }
    const cooldown = numberish(d.triggerCooldown);
    if (cooldown === null) {
      errors.triggerCooldown = `A cooldown is required — ${MIN_COOLDOWN_S} to ${MAX_COOLDOWN_S} seconds.`;
    } else if (!Number.isInteger(cooldown) || cooldown < MIN_COOLDOWN_S || cooldown > MAX_COOLDOWN_S) {
      errors.triggerCooldown = `Use ${MIN_COOLDOWN_S} to ${MAX_COOLDOWN_S} seconds.`;
    }
  }

  const steps = asArray(d.steps);
  if (!steps.length) errors.steps = 'A stack needs at least one step.';

  steps.forEach((raw, i) => {
    const step = raw && typeof raw === 'object' ? raw : {};
    if (!String(step.appId || '').trim()) errors[`step-${i}-appId`] = 'Pick an app for this step.';
    const type = HEALTH_TYPES.includes(step.healthType) ? step.healthType : 'connector';

    if (type === 'port') {
      const port = numberish(step.port);
      if (port === null) errors[`step-${i}-port`] = 'A port gate needs a port number.';
      else if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors[`step-${i}-port`] = 'Ports run from 1 to 65535.';
      }
    }

    const timeout = numberish(step.timeoutMs);
    if (type === 'delay' && timeout === null) {
      errors[`step-${i}-timeoutMs`] = 'A delay gate needs a wait in milliseconds.';
    } else if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS)) {
      errors[`step-${i}-timeoutMs`] = `Use 1 to ${MAX_TIMEOUT_MS} milliseconds.`;
    }
  });

  return { ok: Object.keys(errors).length === 0, errors, stack: stackFromDraft(d) };
}

/** Move a step and return a new array; out-of-range moves are a no-op. */
export function moveStep(steps, from, to) {
  const list = asArray(steps).slice();
  if (!Number.isInteger(from) || !Number.isInteger(to)) return list;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return list;
}

/* ------------------------------------------------------- progress machine */

export function isFinished(run) {
  return !!run && TERMINAL.has(run.phase);
}

export function stepGlyph(phase) {
  return GLYPHS[phase] || '·';
}

/** Colour class for one step glyph — cyan = healthy, red = failed, … */
export function stepStateClass(phase) {
  switch (phase) {
    case 'healthy':
    case 'done':
      return 'ok';
    case 'failed':
      return 'bad';
    case 'triggered':
    case 'launching':
      return 'go';
    case 'waiting':
    case 'stopping':
      return 'wait';
    case 'stopped':
      return 'off';
    default:
      return 'idle';
  }
}

/** A run that has just been asked to start, before the first event lands. */
export function newRun(stackId) {
  return {
    stackId,
    steps: [],
    phase: 'running',
    stepIndex: -1,
    appId: '',
    failedIndex: -1,
    skipped: [],
    finishedAt: 0,
    // Set by a `triggered` event: which watcher started this run.
    reason: '',
  };
}

/**
 * Fold one `stack-progress` event into a run.
 *
 * A `failed` step whose model says `optional` does NOT end the run (main keeps
 * going, per SPEC); a required failure is terminal. Any event arriving after a
 * terminal state starts a fresh run — that is the second click on the tile.
 *
 * @param {object|null} run   previous run state (null = nothing running)
 * @param {object} ev         { stackId, stepIndex, appId, phase }
 * @param {{stack?:object, now?:number}} ctx
 */
export function applyStackProgress(run, ev, ctx = {}) {
  if (!ev || typeof ev !== 'object') return run;
  const stackId = String(ev.stackId || '');
  const phase = PHASES.includes(ev.phase) ? ev.phase : '';
  if (!stackId || !phase) return run;
  if (run && run.stackId && run.stackId !== stackId) return run;

  const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  const stack = ctx.stack || null;
  const fresh = !run || isFinished(run);
  const next = fresh
    ? newRun(stackId)
    : { ...run, stackId, steps: run.steps.slice(), skipped: (run.skipped || []).slice() };

  const idx = Number(ev.stepIndex);
  // SPEC: a run-level verdict (and the v0.6 `triggered` event) carries
  // stepIndex: null — and Number(null) is 0, which would silently light up the
  // first step. Reject the empty cases before the numeric check.
  const hasIdx =
    ev.stepIndex !== null && ev.stepIndex !== undefined && ev.stepIndex !== '' && Number.isInteger(idx) && idx >= 0;
  if (hasIdx) {
    next.steps[idx] = phase === 'done' ? 'healthy' : phase;
    next.stepIndex = idx;
  }
  if (ev.appId) next.appId = String(ev.appId);

  if (phase === 'triggered') {
    // The watcher fired: the run exists before anything launched. Keep the
    // reason so the tile can say WHY it started on its own.
    next.phase = 'triggered';
    if (ev.reason) next.reason = String(ev.reason);
  } else if (phase === 'done') {
    next.phase = 'done';
    next.finishedAt = now;
  } else if (phase === 'stopped') {
    next.phase = 'stopped';
    next.finishedAt = now;
  } else if (phase === 'stopping') {
    next.phase = 'stopping';
  } else if (phase === 'failed') {
    const step = hasIdx && stack ? (stack.steps || [])[idx] : null;
    if (step && step.optional) {
      // An optional gate that timed out: the run walks on to the next step.
      next.phase = 'running';
      if (hasIdx && !next.skipped.includes(idx)) next.skipped.push(idx);
    } else {
      next.phase = 'failed';
      next.failedIndex = hasIdx ? idx : next.failedIndex;
      next.finishedAt = now;
    }
  } else {
    next.phase = 'running';
  }
  return next;
}

/** Why a run started itself, for the tile's status line. */
export function triggerReasonLabel(reason) {
  if (reason === 'adb-device') return 'A device connected — starting…';
  if (reason === 'connector-app') return 'An app joined the bus — starting…';
  return 'Triggered — starting…';
}

export function nameMap(apps) {
  const map = new Map();
  for (const app of asArray(apps)) {
    if (app && app.id) map.set(String(app.id).toLowerCase(), app.name || app.id);
  }
  return map;
}

/** The one line under a stack tile. Sentence case, concrete, English. */
export function runLabel(run, stack, names) {
  if (!run) return '';
  const lookup = names instanceof Map ? names : nameMap(names);
  const steps = (stack && stack.steps) || [];
  const step = steps[run.stepIndex] || null;
  const appId = (step && step.appId) || run.appId || '';
  const appName = lookup.get(String(appId).toLowerCase()) || appId || 'the app';

  switch (run.phase) {
    case 'triggered':
      return triggerReasonLabel(run.reason);
    case 'done':
      return 'Every step is up';
    case 'failed':
      return `${appName} did not come up`;
    case 'stopped':
      return 'Stopped';
    case 'stopping':
      return 'Stopping…';
    default:
      break;
  }
  const phase = run.steps[run.stepIndex] || '';
  if (phase === 'launching') return `Launching ${appName}…`;
  if (phase === 'waiting') return `Waiting for ${appName}…`;
  if (phase === 'healthy') return `${appName} is up`;
  if (phase === 'failed') return `${appName} timed out — carrying on`;
  return 'Running…';
}

/**
 * One line describing when a stack starts itself. Sentence case, concrete.
 * `null` (Manual) has nothing to say.
 */
export function triggerLabel(trigger, names) {
  const t = normalizeTrigger(trigger);
  if (!t) return '';
  if (t.type === 'adb-device') {
    return t.serial ? `Runs when ${t.serial} connects` : 'Runs when a device connects';
  }
  const lookup = names instanceof Map ? names : nameMap(names);
  const name = lookup.get(String(t.appId).toLowerCase()) || t.appId;
  return `Runs when ${name} joins the bus`;
}

/** The cooldown as a plain English tail: "at most once a minute". */
export function cooldownLabel(trigger) {
  const t = normalizeTrigger(trigger);
  if (!t) return '';
  const secs = Math.round((t.cooldownMs || DEFAULT_COOLDOWN_MS) / 1000);
  if (secs === 60) return 'at most once a minute';
  if (secs % 60 === 0) return `at most once every ${secs / 60} minutes`;
  return `at most once every ${secs} seconds`;
}

/**
 * View-ready stack tiles: name, one entry per step (monogram + glyph) and the
 * live run state. The view stays dumb; all of this is testable here.
 *
 * @param {Array} stacks
 * @param {{apps?:Array, runs?:object}} ctx
 */
export function stackTiles(stacks, ctx = {}) {
  const names = nameMap(ctx.apps);
  const runs = ctx.runs && typeof ctx.runs === 'object' ? ctx.runs : {};
  return normalizeStacks(stacks).map((stack) => {
    const run = runs[stack.id] || null;
    const running = !!run && !isFinished(run);
    return {
      id: stack.id,
      name: stack.name,
      running,
      phase: run ? run.phase : '',
      status: runLabel(run, stack, names),
      // v0.6 — a stack that starts itself says so with a bolt and an "auto" chip.
      triggered: !!stack.trigger,
      triggerTitle: stack.trigger
        ? `${triggerLabel(stack.trigger, names)} — ${cooldownLabel(stack.trigger)}${
            stack.trigger.stopOnLeave ? ', and stops when it leaves' : ''
          }`
        : '',
      steps: stack.steps.map((step, i) => {
        const name = names.get(step.appId) || step.appId;
        const phase = run ? run.steps[i] || '' : '';
        return {
          appId: step.appId,
          name,
          monogram: monogram(name),
          hue: tileHue(step.appId),
          optional: !!step.optional,
          health: step.health.type,
          phase,
          glyph: stepGlyph(phase),
          state: stepStateClass(phase),
        };
      }),
    };
  });
}

/* ---------------------------------------------------------- editor pickers */

/** Apps a step may point at: published, with something launchable in them. */
export function pickableApps(apps) {
  return asArray(apps).filter(
    (app) => app && !app.unpublished && (app.artifacts || []).some((a) => isLaunchable(a))
  );
}

/** Artifacts a step may pin. An artifact picker only appears when >1 exists. */
export function stepArtifacts(app) {
  if (!app) return [];
  return (app.artifacts || []).filter((a) => isLaunchable(a));
}

/** Short human summary of a health rule, for the tile title and the list row. */
export function healthLabel(health) {
  const h = normalizeHealth(health);
  if (h.type === 'port') return `port ${h.port || '?'}`;
  if (h.type === 'delay') return `wait ${h.timeoutMs || DEFAULT_DELAY_MS} ms`;
  return 'on the bus';
}
