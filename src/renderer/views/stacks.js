// The Stacks sheet: the list of saved stacks, and the editor for one of them.
//
// Renders a *draft* — app.js owns it and only calls saveStack() on save, the
// same contract the app-options sheet uses.

import { esc } from '../lib/html.js';
import { renderSheet } from './sheet.js';
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DELAY_MS,
  DEFAULT_WAKE_TIMEOUT_MS,
  MIN_COOLDOWN_S,
  MAX_COOLDOWN_S,
  DEFAULT_COOLDOWN_MS,
  TRIGGER_TYPES,
  normalizeStacks,
  isFinished,
  isWakeStep,
  nameMap,
  peerNameMap,
  pickableApps,
  stepArtifacts,
  healthLabel,
  healthTypesFor,
  coerceHealthType,
  triggerLabel,
} from '../lib/stacks.js';
import * as icons from './icons.js';

const HEALTH_TEXT = {
  connector: 'The app reports in on the bus',
  port: 'A TCP port answers',
  delay: 'A fixed wait',
  // v0.7 — the gate that needs no app at all: the other hub is simply there.
  'peer-online': 'The other hub answers',
};

const ACTION_TEXT = {
  launch: 'Launch an app',
  wake: 'Wake a hub',
};

const TRIGGER_TEXT = {
  '': 'Manual — only when I press Run',
  'adb-device': 'When a device connects (adb)',
  'connector-app': 'When an app joins the bus',
};

/* -------------------------------------------------------------------- list */

function stepChain(stack, names, peerNames) {
  return stack.steps
    .map((s) => {
      const wake = isWakeStep(s);
      const peerName = s.peer ? peerNames.get(s.peer) || s.peer : '';
      const label = wake ? `Wake ${peerName}` : names.get(s.appId) || s.appId;
      return `<span class="chain-app" title="ready when: ${esc(healthLabel(s.health))}">${
        wake ? `<span class="chain-power" aria-hidden="true">${icons.power}</span>` : ''
      }${esc(label)}${
        peerName && !wake ? `<span class="step-peer-tag" title="${esc(`runs on ${peerName}`)}">${esc(peerName)}</span>` : ''
      }${s.optional ? '<span class="step-opt">optional</span>' : ''}</span>`;
    })
    .join('<span class="chain-sep" aria-hidden="true">›</span>');
}

function stackRow(stack, ctx) {
  const run = (ctx.runs && ctx.runs[stack.id]) || null;
  const running = !!run && !isFinished(run);
  return `
    <div class="stack-row" data-stack-row="${esc(stack.id)}">
      <div class="stack-row-main">
        <span class="stack-row-name">${esc(stack.name)}${
          stack.trigger
            ? `<span class="st-bolt" aria-hidden="true">${icons.bolt}</span><span class="st-auto" title="${esc(
                triggerLabel(stack.trigger, ctx.names)
              )}">auto</span>`
            : ''
        }</span>
        <span class="stack-row-steps">${stepChain(stack, ctx.names, ctx.peerNames)}</span>
        <span class="stack-row-id">${esc(stack.id)}</span>
      </div>
      ${
        running
          ? `<button class="btn btn-ghost btn-sm" data-act="stack-stop" data-stack="${esc(stack.id)}">Stop</button>`
          : `<button class="btn btn-outline btn-sm" data-act="stack-run" data-stack="${esc(stack.id)}">Run</button>`
      }
      <button class="btn btn-ghost btn-sm" data-act="stack-edit" data-stack="${esc(stack.id)}">Edit</button>
      <button class="btn btn-icon" data-act="stack-delete" data-stack="${esc(stack.id)}" title="Delete ${esc(stack.name)}" aria-label="Delete ${esc(stack.name)}">${icons.trash}</button>
    </div>`;
}

/* ------------------------------------------------------------------ editor */

function selectMarkup(cls, field, index, options, value, label) {
  return `<select class="input ${cls}" data-step-field="${esc(field)}" data-index="${index}" aria-label="${esc(label)}">
      ${options
        .map(
          (o) =>
            `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`
        )
        .join('')}
    </select>`;
}

function errorMarkup(errors, key) {
  return errors && errors[key] ? `<p class="field-error">${esc(errors[key])}</p>` : '';
}

/**
 * One step of the editor.
 *
 * v0.7 adds two controls that only exist when this hub has a fleet: "Runs on"
 * (this hub, or a paired peer) and "Step does" (launch an app, or wake a hub).
 * Without a peer to point at, neither can produce a valid step — so neither is
 * rendered, and the editor looks exactly like v0.6.
 */
function stepMarkup(step, index, ctx) {
  const apps = ctx.apps;
  const known = ctx.peers || [];
  const peerId = String(step.peer || '');
  // A stack can outlive a pairing, and SPEC makes that a RUN-time failure on
  // purpose. So the vanished hub keeps its slot in the picker (the only control
  // that can un-point the step), the step still saves, and a chip says why it
  // will fail if nothing changes.
  const unknownPeer = !!peerId && known.length > 0 && !known.some((p) => p.id === peerId);
  const peers =
    peerId && !known.some((p) => p.id === peerId) ? [...known, { id: peerId, name: peerId }] : known;
  const canPeer = peers.length > 0;
  // A wake with no hub picked YET still renders as a wake — the missing hub is
  // an error under "Runs on", not a reason to undo what the user chose.
  const wake = canPeer && step.action === 'wake';
  const shape = { peer: peerId, action: wake ? 'wake' : 'launch' };
  const peerName = (peers.find((p) => p.id === peerId) || {}).name || peerId;
  const app = apps.find((a) => a.id === step.appId) || null;
  const artifacts = wake ? [] : stepArtifacts(app);
  const type = coerceHealthType(step.healthType, shape);
  const types = healthTypesFor(shape);
  const errors = ctx.errors || {};
  const last = index === ctx.count - 1;
  // On a wake step the timeout is not "how patient is the gate" — it is how
  // long this machine gets to finish booting, so it says that.
  const timeoutLabel = wake ? 'Time to boot (ms)' : type === 'delay' ? 'Wait (ms)' : 'Timeout (ms)';
  const timeoutPlaceholder = wake
    ? DEFAULT_WAKE_TIMEOUT_MS
    : type === 'delay'
      ? DEFAULT_DELAY_MS
      : DEFAULT_TIMEOUT_MS;

  return `
    <div class="stack-step${peerId ? ' step-peered' : ''}${wake ? ' step-wake' : ''}" data-step-row="${index}">
      <div class="step-head">
        <span class="step-n">${index + 1}</span>
        ${
          peerId
            ? `<span class="step-peer${unknownPeer ? ' is-unpaired' : ''}" title="${esc(
                unknownPeer
                  ? `${peerName} is not paired with this hub any more — this step will fail until you pick another hub`
                  : `this step runs on ${peerName}`
              )}">${icons.link}<span>${esc(peerName)}</span>${
                unknownPeer ? '<span class="step-unpaired">not paired</span>' : ''
              }</span>`
            : ''
        }
        ${
          wake
            ? `<span class="step-wake-label">${icons.power}<span>Wake ${esc(peerName || 'a hub')}</span></span>`
            : selectMarkup(
                'step-app',
                'appId',
                index,
                [{ value: '', label: 'Pick an app…' }, ...apps.map((a) => ({ value: a.id, label: a.name }))],
                step.appId,
                `Step ${index + 1} app`
              )
        }
        <span class="step-move">
          <button class="btn btn-icon step-up" data-act="stack-step-up" data-index="${index}" title="Move up" aria-label="Move up"${index === 0 ? ' disabled' : ''}>${icons.chevron}</button>
          <button class="btn btn-icon step-down" data-act="stack-step-down" data-index="${index}" title="Move down" aria-label="Move down"${last ? ' disabled' : ''}>${icons.chevron}</button>
          <button class="btn btn-icon" data-act="stack-step-remove" data-index="${index}" title="Remove step" aria-label="Remove step">${icons.close}</button>
        </span>
      </div>
      ${wake ? '' : errorMarkup(errors, `step-${index}-appId`)}
      ${
        artifacts.length > 1
          ? `<label class="lbl">Which build</label>
             ${selectMarkup(
               'step-art',
               'artifactId',
               index,
               [
                 { value: '', label: 'Whatever is installed' },
                 ...artifacts.map((a) => ({ value: a.id, label: a.label })),
               ],
               step.artifactId,
               `Step ${index + 1} artifact`
             )}`
          : ''
      }
      <div class="step-grid">
        ${
          canPeer
            ? `<div class="step-cell">
                 <label class="lbl">Runs on</label>
                 ${selectMarkup(
                   'step-peer',
                   'peer',
                   index,
                   [{ value: '', label: 'This hub' }, ...peers.map((p) => ({ value: p.id, label: p.name }))],
                   peerId,
                   `Step ${index + 1} hub`
                 )}
                 ${errorMarkup(errors, `step-${index}-peer`)}
               </div>
               <div class="step-cell">
                 <label class="lbl">Step does</label>
                 ${selectMarkup(
                   'step-action',
                   'action',
                   index,
                   [
                     { value: 'launch', label: ACTION_TEXT.launch },
                     { value: 'wake', label: ACTION_TEXT.wake },
                   ],
                   step.action === 'wake' ? 'wake' : 'launch',
                   `Step ${index + 1} action`
                 )}
               </div>`
            : ''
        }
        <div class="step-cell">
          <label class="lbl">Ready when</label>
          ${
            wake
              ? `<p class="step-fixed">${HEALTH_TEXT['peer-online']}</p>`
              : selectMarkup(
                  'step-health',
                  'healthType',
                  index,
                  types.map((t) => ({ value: t, label: HEALTH_TEXT[t] })),
                  type,
                  `Step ${index + 1} health rule`
                )
          }
        </div>
        ${
          type === 'port'
            ? `<div class="step-cell">
                 <label class="lbl">Port</label>
                 <input class="input input-num" type="number" min="1" max="65535" inputmode="numeric"
                        data-step-field="port" data-index="${index}" value="${esc(step.port)}" placeholder="9021"
                        aria-label="Step ${index + 1} port">
               </div>`
            : ''
        }
        <div class="step-cell">
          <label class="lbl">${timeoutLabel}</label>
          <input class="input input-num" type="number" min="1" inputmode="numeric"
                 data-step-field="timeoutMs" data-index="${index}" value="${esc(step.timeoutMs)}"
                 placeholder="${timeoutPlaceholder}"
                 aria-label="Step ${index + 1} timeout">
        </div>
      </div>
      ${
        wake
          ? `<p class="field-note step-note">${esc(
              peerName
                ? `Magic packets go to ${peerName}'s stored MAC address, then the run waits for that hub to answer — give it long enough to finish booting.`
                : 'Pick the hub above: magic packets go to its stored MAC address, then the run waits for it to answer.'
            )}</p>`
          : peerId
            ? `<p class="field-note step-note">${esc(
                `The gate runs on ${peerName} — this hub asks it, and only ${peerName} can see its own bus.`
              )}</p>`
            : ''
      }
      ${errorMarkup(errors, `step-${index}-port`)}
      ${errorMarkup(errors, `step-${index}-timeoutMs`)}
      <label class="check">
        <input type="checkbox" data-step-field="optional" data-index="${index}"${step.optional ? ' checked' : ''}>
        <span class="check-box" aria-hidden="true"></span>
        <span class="check-text">Optional<span class="check-note">if this one never comes up, the run carries on</span></span>
      </label>
    </div>`;
}

/* -------------------------------------------------------------- automation */

function stackSelect(field, options, value, label) {
  return `<select class="input" data-stack-field="${esc(field)}" aria-label="${esc(label)}">
      ${options
        .map(
          (o) =>
            `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`
        )
        .join('')}
    </select>`;
}

/**
 * The Automation block of the editor. Manual is the default and shows nothing
 * else — the whole section stays one line until the user opts in.
 */
function automationBody(draft, ctx) {
  const errors = ctx.errors || {};
  const type = TRIGGER_TYPES.includes(draft.triggerType) ? draft.triggerType : '';
  const apps = ctx.apps;
  const names = ctx.names;

  const typeSelect = stackSelect(
    'triggerType',
    [{ value: '', label: TRIGGER_TEXT[''] }, ...TRIGGER_TYPES.map((t) => ({ value: t, label: TRIGGER_TEXT[t] }))],
    type,
    'When this stack starts'
  );

  if (!type) {
    return `
      <label class="lbl" for="trigger-type">Start this stack</label>
      ${typeSelect}
      <p class="field-note">A trigger lets the stack start itself — when the headset shows up, or when
        another NX app announces itself on the bus.</p>`;
  }

  const target =
    type === 'adb-device'
      ? `<div class="trg-cell">
           <label class="lbl" for="trg-serial">Device serial <span class="lbl-opt">optional</span></label>
           <input id="trg-serial" class="input mono${errors.triggerSerial ? ' invalid' : ''}" type="text"
                  spellcheck="false" autocomplete="off" placeholder="any device"
                  data-stack-field="triggerSerial" value="${esc(draft.triggerSerial || '')}">
           ${errorMarkup(errors, 'triggerSerial')}
         </div>`
      : `<div class="trg-cell">
           <label class="lbl">App on the bus</label>
           ${stackSelect(
             'triggerAppId',
             [{ value: '', label: 'Pick an app…' }, ...apps.map((a) => ({ value: a.id, label: a.name }))],
             draft.triggerAppId || '',
             'Which app starts this stack'
           )}
           ${errorMarkup(errors, 'triggerAppId')}
         </div>`;

  const preview = triggerLabel(
    {
      type,
      serial: draft.triggerSerial,
      appId: draft.triggerAppId,
      cooldownMs: Number(draft.triggerCooldown) * 1000,
    },
    names
  );

  return `
    <label class="lbl" for="trigger-type">Start this stack</label>
    ${typeSelect}
    <div class="trg-grid">
      ${target}
      <div class="trg-cell trg-cool">
        <label class="lbl" for="trg-cool">Cooldown (seconds)</label>
        <input id="trg-cool" class="input input-num${errors.triggerCooldown ? ' invalid' : ''}" type="number"
               min="${MIN_COOLDOWN_S}" max="${MAX_COOLDOWN_S}" inputmode="numeric"
               data-stack-field="triggerCooldown" value="${esc(draft.triggerCooldown || '')}"
               placeholder="${DEFAULT_COOLDOWN_MS / 1000}" aria-label="Cooldown in seconds">
        ${errorMarkup(errors, 'triggerCooldown')}
      </div>
    </div>
    <label class="check">
      <input type="checkbox" data-stack-field="triggerStopOnLeave"${draft.triggerStopOnLeave ? ' checked' : ''}>
      <span class="check-box" aria-hidden="true"></span>
      <span class="check-text">Stop the stack when it leaves<span class="check-note">the apps are asked to quit, in reverse order</span></span>
    </label>
    ${preview ? `<p class="field-note trg-preview">${icons.bolt}<span>${esc(preview)}.</span></p>` : ''}`;
}

function editorBody(draft, ctx) {
  const errors = ctx.errors || {};
  const apps = pickableApps(ctx.apps);
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  return `
    <section class="fieldset">
      <label class="lbl" for="stack-name">Name</label>
      <input id="stack-name" class="input" type="text" spellcheck="false" autocomplete="off"
             data-stack-field="name" value="${esc(draft.name || '')}" placeholder="VR Night">
      ${errorMarkup(errors, 'name')}
      <p class="field-note">The id is built from the name${draft.originalId ? ` — this one is <code>${esc(draft.originalId)}</code>` : ''}.</p>
    </section>

    <section class="fieldset">
      <h3>Steps</h3>
      ${
        apps.length
          ? ''
          : '<p class="field-note">Nothing installable is discovered yet — a step still needs an app to point at.</p>'
      }
      <div class="stack-steps">
        ${steps
          .map((s, i) => stepMarkup(s, i, { apps, errors, count: steps.length, peers: ctx.peers }))
          .join('')}
      </div>
      ${errorMarkup(errors, 'steps')}
      <button class="btn btn-ghost btn-sm" data-act="stack-step-add">Add step</button>
    </section>

    <section class="fieldset">
      <h3>Automation</h3>
      ${automationBody(draft, { apps, errors, names: nameMap(ctx.apps) })}
    </section>`;
}

function listBody(stacks, ctx) {
  if (!stacks.length) {
    return `
      <div class="stack-empty">
        <p class="empty-title">No stacks yet</p>
        <p class="muted">A stack launches several apps in order and waits for each one to come up
          before starting the next.</p>
      </div>`;
  }
  return `<div class="stack-list">${stacks.map((s) => stackRow(s, ctx)).join('')}</div>`;
}

/**
 * @param {{stacks?:Array, apps?:Array, peers?:Array, draft?:object|null,
 *          errors?:object, runs?:object, saving?:boolean}} ctx
 */
export function renderStacksSheet(ctx = {}) {
  const stacks = normalizeStacks(ctx.stacks);
  const draft = ctx.draft || null;
  const names = nameMap(ctx.apps);
  // v0.7 — absent (no fleet, or a build without getFleet) means the whole
  // cross-hub half of the editor never renders.
  const peers = Array.isArray(ctx.peers) ? ctx.peers.filter((p) => p && p.id) : [];

  const body = draft
    ? editorBody(draft, { apps: ctx.apps || [], errors: ctx.errors, peers })
    : listBody(stacks, { names, peerNames: peerNameMap(peers), runs: ctx.runs || {} });

  const foot = draft
    ? `<button class="btn btn-ghost" data-act="stack-cancel">Cancel</button>
       <button class="btn btn-violet" data-act="stack-save"${ctx.saving ? ' disabled' : ''}>Save stack</button>`
    : `<button class="btn btn-ghost" data-act="close-sheet">Close</button>
       <button class="btn btn-violet" data-act="stack-new">New stack</button>`;

  return renderSheet({
    title: draft ? (draft.originalId ? 'Edit stack' : 'New stack') : 'Stacks',
    subtitle: draft
      ? 'Steps run in order — each gate has to pass before the next one launches'
      : `${stacks.length} saved stack${stacks.length === 1 ? '' : 's'}`,
    label: 'Stacks',
    body,
    foot,
    wide: true,
  });
}
