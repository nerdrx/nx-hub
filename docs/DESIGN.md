# The NX Design Language

**Version 1.7 · extracted from NX Hub v0.13.0 · amendments from PulseNX v1.2.1,
the pointer-bound specular rule (2026-08-16), §12 reskin rules from the
Vencord NX theme, §12's opacity rule promoted app-wide (2026-08-20), the
OLED ground — §13, true black, 2026-08-26 — and NX Clear, the modern light
alternative — §14, 2026-09-01**

This document is the canonical specification of the NX visual language —
"liquid glass on deep space." Since v1.6 that space is **actually black**: the
ground is `#000000`, and every colour in the system is light laid on top of it
(§13). It is written to be dropped into any project's
context (Electron, web, Android, or native) and applied without access to the
original codebase. Where this document and an implementation disagree, NX Hub's
`src/renderer/styles.css` is ground truth; update this file when it changes.

The one-sentence version: **dark violet space, frosted glass floating above a
living nebula, light behaving physically, motion behaving like liquid — and
restraint everywhere.**

**Two grounds, one identity (v1.7).** §§1–13 describe the flagship dark
language — the deep-space glass built for surfaces someone stares into. §14 adds
**NX Clear**, a lighter, calmer, rounded ground for surfaces whose job is to be
used and left. Same violet, same mark, same restraint and rhythm — a different
room, not a different brand. Pick the ground by the surface (§14 opens with the
rule); never mix the two within one window.

---

## 1. Identity

| Anchor | Value |
| --- | --- |
| Brand primary | **NX Violet `#7700FF`** — actions, focus, identity. |
| Brand secondary | **Cyan `#00e5ff`** — light *inside* materials: edges, live status, progress. Never a competing surface color. |
| Field | Deep space `#0a0714 → #12091f` vertical gradient, never flat black. |
| Signal colors | Amber `#ffb300` = update/attention. Red `#ff5470` = danger only. |
| The mark | A beveled glass crystal hexagon (pointy-top, always) with a sculpted geometric monogram. |
| Type | System UI stack. No webfonts. Weight and spacing do the branding. |
| Identity accent | An NX app may carry **one** app-specific color for its core domain signal (PulseNX: heart red `#FF2D55` for live vitals). See the rules below. |

Rules that make it feel expensive:

- Violet **dominates**; cyan is subordinate — a light source, not a paint.
- Everything translucent is **low-alpha**. If a gradient is visible from across
  the room, halve it.
- No solid gray lines anywhere. Dividers are gradient hairlines that fade at
  both ends.
- **Angular, never rounded.** Radii stay in the 3–6px band; pill shapes are
  banned. The mark is a faceted crystal and every container echoes its cut
  edges — large radii read as a toy. Perfect circles are reserved for status
  dots and spinners only.
- One light source: **upper-left**, in every gradient, bevel, and edge. Light
  consistency is why surfaces read as one physical world.
- **Light rides motion — it never flashes on command.** A specular sheen is a
  *function of position*, not a time-triggered animation: bind it to the
  pointer, the tilt, the scroll or the progress value that is actually moving,
  so the highlight slides across the glass as the thing moves. A one-shot
  sweep fired on hover/attention reads as an effect; light that tracks input
  reads as material. Triggered sweeps are permitted only where no continuous
  driver exists (indeterminate progress), and everything decorative still
  freezes under reduced motion.
- **The identity accent stays in its lane.** If an app has a domain signal
  color, it marks *only* that signal (the live BPM, the recording dot). It
  never becomes an action color, never doubles as danger or any generic
  status, and violet still leads every screen. When a domain needs a graded
  ramp (heart-rate zones), build it inside the cyan → violet → magenta band
  and let the identity color cap the extreme; amber still means only
  "attention."

## 2. Design tokens

Copy these verbatim into `:root` (CSS) or mirror them as resources (Android
§10). They are the entire system; components are compositions of tokens.

```css
:root {
  /* brand (frozen — never restyle these) */
  /* v1.6: the ground is TRUE BLACK. On an OLED those pixels are off, which is
     what makes the violet read as emitted light rather than as a tinted panel.
     Both stops are #000 so a field that spans the viewport cannot band. */
  --bg-top: #000000;
  --bg-bottom: #000000;
  --panel: #0c0818;
  --panel-2: #120c22;
  --violet: #7700ff;
  --violet-soft: #9a3cff;
  --cyan: #00e5ff;
  --amber: #ffb300;
  --text: #efeaff;
  --muted: #9a8fc0;
  --line: #241a3c;
  --danger: #ff5470;

  /* geometry — ANGULAR. Corners are cut, not rounded; sharpness echoes the
     faceted crystal mark. Pills are banned outright. */
  --radius: 6px;       /* cards, sheets */
  --radius-sm: 4px;    /* rows, wells, inputs */
  --radius-xs: 3px;    /* chips, code */
  --pill: 5px;         /* legacy token name — buttons/tabs/badges, cut sharp */
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Cantarell, sans-serif;
  --mono: ui-monospace, "JetBrains Mono", "Fira Code", Consolas, monospace;

  /* glass fills — light collects top-left and drains to a cool shadow */
  --glass-bar: linear-gradient(180deg, rgba(22, 14, 40, 0.72) 0%, rgba(4, 2, 10, 0.86) 100%);
  --glass-1: linear-gradient(157deg, rgba(255, 255, 255, 0.09) 0%, rgba(255, 255, 255, 0.026) 34%,
      rgba(23, 16, 40, 0.34) 100%);
  --glass-2: linear-gradient(158deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 30%,
      rgba(19, 12, 34, 0.66) 100%);
  --glass-chip: linear-gradient(180deg, rgba(255, 255, 255, 0.09) 0%, rgba(255, 255, 255, 0.028) 100%);
  --well: linear-gradient(180deg, rgba(0, 0, 0, 0.62) 0%, rgba(0, 0, 0, 0.42) 100%);
  /* v1.5: STRUCTURAL surfaces are opaque elevation steps (see §4)
     v1.6: and those steps sit just BARELY off black — a lift, not a slab (§13) */
  --surface-1: linear-gradient(157deg, #130d24 0%, #0d0819 46%, #070410 100%);
  --surface-1-hover: linear-gradient(157deg, #181031 0%, #110c22 46%, #0a0616 100%);
  --well-deep: linear-gradient(180deg, rgba(4, 2, 10, 0.62) 0%, rgba(4, 2, 10, 0.46) 100%);

  /* blur strengths — ONLY these three exist */
  --blur-bar: blur(22px) saturate(170%);
  --blur-sheet: blur(34px) saturate(185%);
  --blur-chip: blur(16px) saturate(160%);

  /* lit edges — 1px gradient borders, bright top-left → dark bottom-right */
  --edge: linear-gradient(147deg, rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0.09) 24%,
      rgba(255, 255, 255, 0.015) 52%, rgba(0, 0, 0, 0.34) 100%);
  --edge-lit: linear-gradient(147deg, rgba(226, 200, 255, 0.62) 0%, rgba(154, 60, 255, 0.28) 30%,
      rgba(0, 229, 255, 0.1) 58%, rgba(0, 0, 0, 0.3) 100%);
  --edge-top: rgba(255, 255, 255, 0.18);
  --hairline: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.09) 18%,
      rgba(255, 255, 255, 0.13) 50%, rgba(255, 255, 255, 0.09) 82%, rgba(255, 255, 255, 0) 100%);
  --sheen: linear-gradient(112deg, rgba(255, 255, 255, 0) 30%, rgba(255, 255, 255, 0.085) 45%,
      rgba(214, 190, 255, 0.05) 52%, rgba(255, 255, 255, 0) 68%);

  /* elevation */
  --shadow: 0 14px 34px -12px rgba(0, 0, 0, 0.72), 0 2px 8px rgba(0, 0, 0, 0.3);
  --shadow-lift: 0 26px 54px -16px rgba(0, 0, 0, 0.8), 0 0 40px -8px rgba(119, 0, 255, 0.34);
  --shadow-bar: 0 20px 44px -24px rgba(0, 0, 0, 0.9), 0 1px 0 rgba(255, 255, 255, 0.04);
  --shadow-sheet: 0 48px 96px -32px rgba(0, 0, 0, 0.86), 0 0 0 1px rgba(255, 255, 255, 0.06);
  --focus-ring: 0 0 0 2px rgba(119, 0, 255, 0.6), 0 0 0 5px rgba(119, 0, 255, 0.2);

  /* motion */
  --ease-spring: cubic-bezier(0.32, 1.35, 0.42, 1);  /* overshoots — pills, tab indicator */
  --ease-soft: cubic-bezier(0.2, 0.8, 0.2, 1);       /* default interactive */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);         /* entrances */
  --dur-fast: 150ms;
  --dur: 220ms;
  --dur-slow: 320ms;

  /* 8px rhythm */
  --sp-1: 8px;
  --sp-2: 16px;
  --sp-3: 24px;
  --sp-4: 32px;
}
```

## 3. The living background

Glass is only convincing when there is light behind it to refract. Every NX
surface sits above two fixed, full-viewport layers:

1. **Nebula** — two to three enormous radial-gradient blobs (violet upper-left,
   cyan lower-right, optionally a deep magenta third) at very low alpha over
   the `--bg-top → --bg-bottom` field, drifting on `transform`-only keyframe
   animations with **periods of 60–110 seconds**, alternating direction. Add a
   soft vignette so edges stay darker than center.
2. **Starfield** — sparse, tiny, static or near-static points at low opacity.
   Decoration, not attraction.

Both layers pause when the document is hidden and freeze entirely under
`prefers-reduced-motion`. If you build one custom canvas, budget it: two
layers, transform-only, `requestAnimationFrame` parked when not visible.

## 4. The glass tier system

**The cardinal performance rule: real `backdrop-filter` is a budget, not a
default.** Reserve it for the few floating surfaces that overlap other content.
Everything else *synthesizes* glass from the translucent gradient fills — the
nebula glowing through low-alpha fills reads as frosted glass at a fraction of
the cost.

| Tier | Surfaces | Fill | Blur | Edge | Shadow |
| --- | --- | --- | --- | --- | --- |
| **Bar** | app header, floating toolbars | `--glass-bar` | `--blur-bar` (real) | 1px `--edge-top` top highlight | `--shadow-bar` |
| **1 — Card** | content cards, tiles | `--surface-1` (**opaque**) | none | `--edge` gradient border | `--shadow` |
| **2 — Sheet** | modals, slide-overs, menus, toasts | `--glass-2` | `--blur-sheet` / `--blur-chip` (real) | `--edge-lit` | `--shadow-sheet` |
| **Well** | recessed regions *inside* glass (list rows, code, logs) | `--well` / `--well-deep` | never | none or `--line` | inset only |

**v1.5 — the opacity rule, promoted from §12.** What began as a reskin
constraint proved to be the better look everywhere: **structural, always-
present surfaces (cards, tiles, rails) are OPAQUE elevation steps**
(`--surface-1`, hover steps to `--surface-1-hover`) — depth comes from surface
steps and the lit edge, never from see-through. The nebula lives *between* the
panels, not behind them. Translucency + real blur are reserved for layers that
genuinely float (bars over scrolling content, sheets, menus, toasts), and a
floating layer's fill stays **≥ 0.85 alpha** so nothing behind it shows
through its body. `--glass-1` remains for legacy/edge uses but new structural
surfaces take `--surface-1`.

Implementation notes:

- The 1px gradient edge is a `border-image` or a masked pseudo-element painting
  `--edge` — brighter top-left, darker bottom-right, matching the global light.
- **Glass inside glass reads as fog.** Content regions inside a card are wells
  (recessed dark surfaces), never a second frosted layer. This is what keeps
  hierarchy legible.
- Menus and toasts carry legibility in their **fill alpha (≥0.9)**; blur is
  finish, not the mechanism. Text over blur alone becomes unreadable over busy
  content.
- Keep simultaneous real-blur elements at roughly **≤10 visible**; on a screen
  with dozens of cards, that is exactly why cards fake it.
- Give cards `isolation: isolate` so internal z-ordering can't leak, and
  elevate any card with an open menu above its siblings.

## 5. Components

**Buttons** are sharp-cut glass blocks (`--pill` radius — a 5px chamfer, not a pill). Primary: violet fill with an
inner top highlight and a soft violet glow; hover lifts 1–2px
(`translateY(-1px)`) and blooms the glow; press scales to `0.96`. Secondary:
`--glass-chip` fill with `--edge` border. Danger uses `--danger` only for
genuinely destructive actions. Amber is reserved for "update available" class
actions. Disabled: 40% opacity, no hover response.

**The tab indicator**: navigation tabs share one sliding indicator — a single
element translated between equal-width tab slots with `--ease-spring`, never
per-tab background toggles. (CSS-only via `:has()` on the active tab.)

**Cards**: tier-1 glass, `--radius`, `--sp-3` internal padding. Hover: lift
`translateY(-2px)` and `--shadow-lift`. The `--sheen` band is **pointer-bound**
(see the light-rides-motion rule): a delegated pointermove writes a normalized
CSS custom property (e.g. `--mx: 0..1`) on the hovered surface and the sheen's
position derives from it — the highlight slides with the cursor instead of
sweeping once on entry. Keep it one rAF-throttled listener per grid, not one
per card; a soft opacity fade on enter/leave keeps the appearance calm. Card grids flow
as **masonry** (CSS `columns`, `break-inside: avoid`) so mixed heights pack
tightly — top-aligned grid rows with ragged holes read as fragmentation.

**Chips / badges**: uppercase micro-labels, 10–11px, `letter-spacing: 0.12em+`,
`--glass-chip` fill, sharp-cut corners. Status chips: cyan = live/connected,
amber = pending attention, muted = inert.

**Progress**: a recessed well trough with a luminous violet→cyan liquid fill
and a slow moving sheen. Indeterminate = full-width pulsing sheen.

**Inputs**: well-recessed fields, `--radius-sm`, 1px `--line` border that
transitions to violet on focus with `--focus-ring`. Never a bare `outline`.

**Sheets & modals**: rise from below with `--ease-out` at `--dur-slow` while a
scrim dims and blurs in; the sheet itself is tier-2. Escape and scrim-click
dismiss.

**Toasts**: small tier-2 chips, bottom-right stack with 6–10px offsets,
slide+fade in, auto-dismiss non-errors.

**Empty states**: one short bold line, one muted sentence, one primary action.
Centered, generous whitespace, no illustration clutter.

## 6. Motion

Motion is liquid, brief, and interruptible.

- Animate **transform and opacity only**. Never width/height/top/left.
- Interaction feedback at `--dur-fast`, view changes at `--dur` to
  `--dur-slow`. Nothing interactive exceeds 320ms.
- `--ease-spring` (with overshoot) is for playful, identity-bearing moves: the
  tab pill, a tile press. `--ease-soft` is the workhorse. `--ease-out` for
  entrances.
- View switches: 180ms crossfade + ~8px slide. No layout jank; keep it
  interruptible.
- **`prefers-reduced-motion: reduce` is non-negotiable**: nebula frozen,
  sheens off, springs replaced, every transition collapses to opacity.

## 7. Typography & rhythm

- System stack (`--font`); code and version strings in `--mono`.
- Scale: 20–22px bold titles · 14px body · 12–13px secondary (`--muted`) ·
  10–11px uppercase micro-labels with wide tracking. Weights 600–700 for
  headings, 400–500 body.
- Body text is always `--text` on dark surfaces — verify contrast stays
  WCAG-comfortable over glass. If a fill fights the text, darken the fill.
- **Everything sits on the 8px grid** (`--sp-*`). When in doubt: 16 inside,
  16–24 between siblings, 24–32 between sections.
- Numbers, sizes, and dates format **locale-independently** (host machines may
  run any locale) — no bare `toLocaleString` in logic paths.

## 8. Iconography & the mark

- The NX mark is a **pointy-top hexagon** everywhere. Never flat-top.
- Three size variants exist and are mandatory — one file cannot span
  16→512px: the **master** (full bevel + well + refraction, ≥48px), the
  **small** variant (wider cut, no bevel, flat white monogram, ≤32px), and the
  **tray** variant (flat brand violet, knocked-out monogram — survives OS
  tinting on light and dark trays).
- Masters live in NX Hub's `assets/` (`icon.svg`, `icon-small.svg`,
  `tray.svg`); derive all rasters from the *correct variant per size*. Never
  scale the master below 48px.
- UI glyphs: stroked, geometric, 1.5–2px stroke at 16–20px box, `currentColor`,
  inline SVG. No emoji as UI iconography, no icon fonts.
- App tiles without a real icon get a **deterministic monogram tile**: 1–2
  letters on a radial gradient whose hue is hashed from the app's id, clamped
  to the cyan→violet band (187–290°). Never substitute the NX brand mark for a
  third-party app's identity.

## 9. Voice

UI copy is English, short, and concrete. Sentence case everywhere except
micro-label chips (uppercase). Errors say what happened *and what to do next*
("Could not reach 192.168.1.50 — check that the device is on the same
network"). No exclamation marks, no cutesy mascot voice, no jargon in
user-facing strings. Empty states invite the next action rather than apologize.
Destructive and irreversible actions always confirm, stating the consequence
plainly.

## 10. Applying it outside the web stack

**Android (Views or Compose)** — map tokens to resources: `nx_violet #7700FF`,
`nx_cyan #00E5FF`, `nx_bg #0A0714`, `nx_panel #171028`, `nx_text #EFEAFF`,
`nx_muted #9A8FC0`, `nx_amber #FFB300`. Cards: `--panel`-toned surfaces with
subtle top-light gradient (real blur is rarely worth it on mobile GPUs — fake
tier-1 exactly like the desktop cards); wells as darker inset containers;
sharp-cut violet buttons; 8dp rhythm; the adaptive launcher icon derives from
the mark's foreground/background split with a monochrome variant. Motion via
`OvershootInterpolator`-class curves at the same durations.

Field notes from the PulseNX implementation:

- **`<stroke>` cannot take a gradient**, so `--edge` is faked: a uniform
  low-alpha stroke plus separate lit-top and shadowed-bottom edge strips.
  Do **not** fake the sheen with a clipped diagonal specular band — the clip
  ends in a visible seam on real screens.
- **Reduced motion** has no single Android flag. Treat
  `ANIMATOR_DURATION_SCALE == 0` **or** `TRANSITION_ANIMATION_SCALE == 0` as
  reduce, re-read both every time the window becomes visible, and give any
  custom canvas hard stops for detach, invisibility, and battery saver.
- **Press feedback recipe**: scale to `0.96` in 150 ms on down, release
  through an `OvershootInterpolator(≈2.2)` over 220 ms — and the touch
  listener must return `false` so clicks pass through.

**Native desktop (Qt/GTK/imgui)** — the tier table survives translation: bar
and sheet surfaces get real blur where the toolkit offers it, content surfaces
use the gradient-fill fake, wells recess. The tokens are the contract; the
technology is negotiable.

**Terminal/CLI apps** — violet primary accents, cyan for live values, amber
for warnings, muted lavender for secondary text; uppercase wide-tracked section
labels echo the chip language.

The concrete mapping, as implemented in NX Hub's `nx` command
(`src/cli/ansi.js`), is 24-bit SGR — no 256-colour approximations, no
dependencies:

| Token | Escape | Used for |
| --- | --- | --- |
| Violet `#7700FF` | `ESC[38;2;119;0;255m` | section labels, command names, the filled part of a progress bar |
| Cyan `#00e5ff` | `ESC[38;2;0;229;255m` | live values: versions, percentages, counts, the `✓` glyph |
| Amber `#ffb300` | `ESC[38;2;255;179;0m` | update available (`↑`), throttling, anything asking for attention |
| Muted `#9a8fc0` | `ESC[38;2;154;143;192m` | secondary text, table headers, key columns |
| Text `#efeaff` | `ESC[38;2;239;234;255m` | body rows |
| Red `#ff5470` | `ESC[38;2;255;84;112m` | failures only |
| — | `ESC[2m` (dim) | the trough of a bar, hints, the bottom "other repos" block |

Section labels are `track()`ed — `"Apps"` → `A P P S` — the terminal's version
of the uppercase micro-label chip. Status is carried by three glyphs and never
by emoji: `✓` up to date (cyan), `↑` update available (amber), `·` not
installed (muted). Progress is one line rewritten with `\r`: violet `█` fill on
a dim `░` trough, cyan percentage, muted phase. Everything degrades to plain
ASCII when the stream is not a TTY, when `NO_COLOR` is set, or on `--plain` —
the layout is identical, only the escapes disappear, and the bar becomes one
line per phase so logs stay readable.

## 11. The review checklist

Review by **looking, not by reading code**: render every view with real or
synthetic data, screenshot it, and iterate until the list below passes — the
failures this catches (ragged grid holes, collapsed rhythm, seamed gradients)
are invisible in a diff. Before shipping any NX-branded surface, verify:

- [ ] Light comes from the upper-left in every gradient and edge.
- [ ] Real blur count on a busy screen ≤ ~10; cards fake it.
- [ ] No solid gray dividers; hairlines fade at both ends.
- [ ] Violet leads, cyan accents, amber only means "attention."
- [ ] All spacing lands on the 8px grid.
- [ ] Hover lifts, press scales, springs only where identity lives.
- [ ] Every sheen is position-driven (pointer/tilt/progress), never a one-shot
      triggered sweep — except where nothing continuous exists to bind to.
- [ ] `prefers-reduced-motion` fully honored.
- [ ] Text contrast comfortable over every fill it sits on — and never pure
      `#fff` on the black ground (§13).
- [ ] The ground is actually `#000000`, and the corners of the vignette reach it.
- [ ] Cards separate from the page by their lit edge, not by a lighter fill.
- [ ] No banding rings in the nebula: look at a full-screen grab on a real OLED,
      not at a scaled-down screenshot, which hides them.
- [ ] Nothing large, bright and permanently in the same place (§13, burn-in).
- [ ] Mixed-height collections pack (masonry), never leave ragged holes.
- [ ] No pill shapes; every radius is in the 3–6px band (circles = dots/spinners only).
- [ ] The mark is pointy-top, correct variant for the size — and an app's own
      mark is never replaced by the NX hexagon.
- [ ] The identity accent (if any) marks only its domain signal — never
      actions, danger, or generic status.
- [ ] Copy is sentence-case, concrete, and tells the user what to do next.

## 12. Reskinning a host UI you don't own

Everything above assumes we build the markup. Sometimes we don't — we drop NX
onto a host we can't rebuild (a Discord client mod, an injected userstyle, a
browser extension). You get one lever: CSS over someone else's DOM. That
inverts several defaults, and the mistakes here are the ones that make a skin
read as *a hack* instead of a product. Learned building the Vencord NX theme.

- **Recolor at the host's design-token layer, not its class names.** Modern apps
  expose their palette as CSS custom properties; override those and the whole
  app turns at once. Set **both** the legacy and current token names (Discord:
  `--background-*`/`--brand-experiment` *and* the newer `--bg-base-*` semantic
  set) so you survive the app mid-migration. Targeting hashed class names is a
  treadmill — they churn every release; tokens are stable surface area.

- **Opaque structural surfaces; glass only on what truly floats.** §4's budget
  rule becomes absolute here: in a host you don't own you can't guarantee
  stacking order, so a translucent *flat* panel will let an unrelated layer
  bleed through it — the single ugliest tell. Give the always-present frame
  (rails, sidebars, header, content) an **opaque** deep-violet elevation ramp;
  depth comes from surface steps, not see-through. Reserve translucency + real
  blur for genuinely floating layers (menus, modals, popouts, tooltips), and
  keep their fill alpha **≥ 0.85** so nothing behind them shows.

- **The field is one ambient bloom on the root — not a layer behind every
  panel.** §3's nebula+starfield assumes you own the stack and can park two
  fixed layers *below* everything. Injected into a host you don't, a field
  repeated behind each surface fights legibility and looks cheap. Deliver "deep
  space" as a single upper-left violet glow painted on the host's root
  background. If the field is visible through more than the outermost frame,
  it's too much — halve it, then halve it again.

- **Never touch the host's z-index or stacking.** Forcing children into a
  stacking context so you can slip a background pseudo-element behind them
  reorders the host's own popout/overlay layers and produces ghosting and
  cut-off content. Paint the field on the root element's *own* `background`
  (layered `background-image`); add nothing to the stacking order.

- **Consistency is the entire game.** One hairline, one hover, one selected
  state, one radius scale, reused everywhere. When you're overriding a UI you
  didn't design, a *single* panel with a different alpha or a stray rounded
  corner is the difference between "designed" and "userstyle." Uniformity reads
  as intent.

Review addendum for skins: screenshot the host with menus, modals, and a
settings page **open**, and confirm no layer shows through another; then confirm
every structural panel shares one fill and one separator.

---

*Reference implementation: [nerdrx/nx-hub](https://github.com/nerdrx/nx-hub) —
`src/renderer/styles.css` (tokens & components), `src/renderer/views/`
(component markup), `assets/` (the mark). Reskin reference:
[nerdrx/vencord-nx-plugins](https://github.com/nerdrx/vencord-nx-plugins) —
`themes/nx.theme.css`.*

## 13. The OLED ground (v1.6)

The field is `#000000`. Not "very dark violet" — black, so the panel switches
those pixels **off**. Everything else in this document is light laid on that
black, and the whole system gets sharper for it: `#7700FF` stops competing with
a lit violet-grey background and starts behaving like what it is, an emitter.

This is not a palette swap. Five things change about how you build a surface.

**1. Shadow stops working, so edges carry elevation.** You cannot darken black.
A drop shadow under a card on a `#000` page is invisible — the pixels it falls
on are already off. Depth now comes from the two things that still read: the
1px lit edge (§4) and a surface that sits *just* off black. Keep shadows for
where surfaces overlap each other, and give them a violet ambient
(`0 0 26px -14px rgba(119,0,255,.22)`) — coloured light IS visible on black
where neutral shade is not.

**2. Structural surfaces are a lift, not a slab.** `--surface-1` tops out
around `#130d24`. That is roughly a third of the luminance v1.5 used, and it is
deliberate: on black, a few percent of lift plus a lit top edge is already a
legible card. A lighter fill does not read as "more elevated", it reads as
"grey box on an OLED", which is the exact look this ground exists to avoid.
Floating layers (§4, §12) still fill ≥0.85 — being clearly above the page
matters more than being dark.

**3. Big soft gradients band, so dither them.** A nebula blob is an enormous
gradient at a few percent alpha. Over a lifted background its steps hide in the
noise floor; over true black each step is visible as a ring, and worst on the
panel that renders black perfectly. Lay a static noise texture over the
background layers at **3–4% opacity** (an inline `feTurbulence` SVG is enough).
At that strength nobody sees grain; they see the bands not being there. Prefer
flat fills for large areas and keep gradients short in range.

**4. Never pure white on pure black.** `--text: #efeaff` is already off-white
and stays that way. Full `#ffffff` on `#000000` halates on OLED — the text
blooms and thin strokes smear on subpixel layouts that are not RGB stripe. The
same applies inverted: no huge sheet of near-white anywhere.

**5. A launcher sits open, so mind burn-in.** The hub is a window people leave
running for months, which makes any permanently-bright, permanently-positioned
element a real risk — not a theoretical one. Keep static chrome (header, rails,
tab strip) dark and translucent; let the bright violet appear on things that
move, change, or are transient (the active tab, a primary button, a progress
fill, a toast). Nothing large, bright and fixed.

**What does not change:** `#7700FF` is still the accent and still dominates;
cyan is still light *inside* materials (live values, meters, progress) and never
a surface; amber is still attention and `#ff5470` still danger; geometry is
still angular (§2); light still rides the pointer (§4). The nebula still
drifts — it just drifts over black now, which is what "deep space" meant all
along.

## 14. NX Clear — the modern light ground (v1.7)

Everything above is the dark flagship: deep-space glass, engineered to feel
expensive on a screen someone stares into. That atmosphere is *wrong* for a
surface whose job is to be used and left — a tray flyout open for three seconds,
a menu-bar utility, an installer, onboarding, a marketing page, this document
rendered as a site. There, "liquid glass on a living nebula" reads as heavy and
slow; the job wants **air, not atmosphere**. NX Clear is that ground: the same
identity worn light.

The one-sentence version: **paper-calm neutral, one violet accent, soft rounded
surfaces with real diffuse shadow — restraint doing the work the nebula did in
deep space.** First shipped as the NX Toolbox flyout.

**The selection rule — decide once, per surface, before you build:**

- **NX Clear (§14)** — anything a person uses to get something done and then
  leaves, and anything a stranger sees first: **NX Hub** and its family of
  tools, tray/menu-bar flyouts, installers, settings, onboarding, marketing,
  docs. Light-first, flat, rounded, calm. This is the ground that has to look
  professional to someone who has never heard of us.
- **Deep space (§§1–13)** — surfaces that ARE the screen and are stared into for
  hours: in-headset and immersive UI, media and performance tools, live
  dashboards, and dark hosts we reskin (§12). Dark, glass, angular,
  atmospheric.
- **Never mix the two inside one window.** A Clear popover launched from a
  deep-space app is fine — different windows. A glass card dropped into a Clear
  panel is the tell that someone reached for the wrong sheet.

> **Amended 2026-09-01.** NX Hub itself moved from deep space to Clear
> (v0.14.0), on the call that the product people meet first should read clean
> and professional rather than atmospheric. The reference implementation of
> Clear is now `nx-hub/src/renderer/styles.css`; §§1–13 stay normative for the
> deep-space apps, which did not move.

Five axes invert from the flagship. Everything not listed as inverted is
**shared** and unchanged — read it off §§1–13.

**1. The ground is light, and theme-aware.** No nebula, no starfield, no living
background — a Clear surface sits on a near-white neutral with a *faint violet
bias* (chosen, not pure grey), and ships a true dark variant for OS dark mode.
The default is light; deep space's default is dark. The background is flat or
carries at most one soft off-screen violet bloom in a corner — never a full
field behind every panel.

**2. Geometry is rounded — the one hard inversion of §2.** Deep space bans pills
and clamps radii to 3–6px because it echoes a faceted crystal. NX Clear is soft:
**radii 9–14px on controls and tiles, 16–20px on panels**, and pills *are*
allowed for chips and toggles. Rounded is the whole feel; do not carry the
angular rule across. (The mark itself stays the pointy-top hexagon in-product —
§8 is identity, not surface — but icon containers and tiles round with
everything else.)

**3. Depth comes from shadow, because the ground can hold it.** The exact
opposite of §13: on light, a soft diffuse drop shadow *works* and is the primary
elevation cue, paired with a **1px solid hairline** in a low-contrast line
token. No lit gradient edges, no `--edge`/`--edge-lit`, no synthesized glass
tiers. Cards are flat opaque fills separated by shadow + hairline. Reserve real
`backdrop-filter` for the one floating layer that overlaps live content (a
menu-bar flyout over the desktop) — and even there keep it subtle.

**4. Violet is a spark, not a field.** In deep space violet dominates every
screen. In Clear the surfaces are neutral and violet appears **only** on what
acts or identifies: the primary button, the active tile, focus rings, the mark,
one accent line. A Clear panel that is mostly violet is over-painted — pull it
back to neutral and let the accent land once. Cyan is optional here and, when
used, stays a value/status colour exactly as in §1; most Clear surfaces skip it
entirely.

**5. Motion is calmer.** The liquid principles hold (transform/opacity only,
reduced-motion non-negotiable, §6 durations), but the register is quieter: a
single spring **pop** on a flyout open (`--ease-spring`, ~220ms scale+fade from
the anchor corner), soft crossfades between views, gentle tile hovers. No
pointer-bound specular sheen — that is a glass behaviour; Clear surfaces are
matte and a moving highlight looks out of place.

**What is shared and does not change:** the violet `#7700FF` identity and the NX
mark (§8); sentence-case, concrete voice (§9); the 8px rhythm and system-font
typography (§7); transform/opacity-only, interruptible, reduced-motion-honouring
motion (§6); and *restraint* — Clear is even more spartan than deep space,
because it has no atmosphere to hide behind.

### 14.1 NX Clear tokens

A parallel `:root` set. Theme-aware: light on bare `:root`, dark redefined under
`prefers-color-scheme` and an explicit `[data-theme]` stamp. Only the tokens
change between themes; components read tokens.

```css
:root {
  /* neutrals — a chosen off-white with a faint violet bias, not pure grey */
  --clear-bg: #fafafc;          /* page ground */
  --clear-surface: #ffffff;     /* cards, panels, tiles */
  --clear-tile: #faf9fd;        /* recessed tile fill */
  --clear-ink: #1a1823;         /* body text (never pure #000) — 17.5:1 on surface */
  /* Measured, not chosen by eye. The first draft printed #78748a, which is
     4.30:1 on --clear-tile and 3.95:1 on --violet-soft — under AA for the
     11–13px secondary text these UIs are full of. Darkened until it clears
     4.5:1 on every surface it is allowed to sit on. */
  --clear-muted: #6c687e;       /* secondary text — 5.1–5.4:1 */
  /* Ornament ONLY: separators, disabled glyphs, inert marks. It never carries a
     word anyone has to read — placeholders use --clear-muted — but it still
     clears 3:1. The first draft's #a7a3b8 was 2.45:1 on white. */
  --clear-faint: #8b8799;       /* tertiary — 3.3–3.5:1, never body text */
  --clear-line: #ece9f4;        /* 1px hairline — solid, low contrast */
  --clear-line-strong: #ddd8ea; /* where a hairline must survive on white: table rules, inputs */
  --clear-line-accent: #ded0ff; /* hairline warmed toward the accent on hover/active */

  /* identity — the ONE accent, used sparingly */
  --violet: #7700ff;            /* actions, focus, identity (shared with §2) */
  --violet-2: #9a4dff;          /* hover brighten, marks */
  --violet-soft: #f4edff;       /* accent wash: active tile, icon well */
  /* White on --violet-2 is 4.30:1, so a literal violet→violet-2 fill puts a
     sub-AA band across the top of every primary button. The gradient stays; its
     light stop is the darkest violet that still clears AA under white (5.12:1).
     Dark's --violet (#a566ff) gives white only 3.53:1, hence --on-accent. */
  --accent-fill: linear-gradient(180deg, #8c37ff 0%, var(--violet) 100%);
  --on-accent: #ffffff;         /* dark theme: #140b22 */

  /* status (optional; borrow §1 semantics) */
  /* Brand cyan #00e5ff is unreadable as text on white (1.6:1) — on the light
     ground the LIVE-value colour is this darkened cyan. Dark keeps #00e5ff. */
  --cyan: #00707f;        --cyan-soft: #e4f5f8;
  --clear-good: #0c6f3c;  --clear-good-soft: #e6f6ec;   /* #12894a was 3.99:1 on its own tint */
  --clear-warn: #8a6100;  --clear-danger: #c22030;

  /* geometry — ROUNDED (inverts §2) */
  --clear-r-panel: 20px;   /* flyouts, sheets */
  --clear-r-card: 14px;    /* cards, tiles */
  --clear-r-control: 11px; /* buttons, inputs */
  --clear-r-mini: 9px;     /* micro-tags, inline code — the floor of the band */
  --clear-r-chip: 999px;   /* pills ARE allowed here */

  /* elevation — soft diffuse shadow is the primary depth cue */
  --clear-shadow-card: 0 1px 2px rgba(40,20,90,.05), 0 4px 12px -4px rgba(40,20,90,.10);
  --clear-shadow-pop:  0 24px 60px -20px rgba(40,20,90,.35), 0 6px 20px -8px rgba(40,20,90,.18);
  /* Order matters: a 3px spread listed FIRST paints over a 1px one and the
     violet never renders — the ring becomes an invisible lilac wash. */
  --clear-focus: 0 0 0 2px var(--violet), 0 0 0 5px var(--violet-soft);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --clear-bg: #000000;  --clear-surface: #121017;  --clear-tile: #17141f;
    --clear-ink: #f4f3f8; --clear-muted: #9c98ab;    --clear-faint: #6a6678;
    --clear-line: #262330;
    --violet: #a566ff;    --violet-2: #c79bff;       --violet-soft: #241a38;
    --clear-good: #4cd97b; --clear-good-soft: #12291b;
    --clear-shadow-card: 0 1px 2px rgba(0,0,0,.4), 0 4px 12px -4px rgba(0,0,0,.5);
    --clear-shadow-pop:  0 24px 60px -20px rgba(0,0,0,.6), 0 6px 20px -8px rgba(0,0,0,.5);
  }
}
/* repeat the dark block under :root[data-theme="dark"] so the toggle wins both ways */
```

**Clear's dark variant leans OLED (amended 2026-09-01).** The first draft of
this section kept the dark ground at a lifted `#0b0a10`, reasoning that Clear
depends on shadow and shadow needs a surface to fall on. That reasoning is
sound but the conclusion was wrong for our screens: the dark ground is
`#000000`, and the **hairline takes over from the shadow** as the separator —
which Clear already has and deep space does not. So on the dark variant:
surfaces lift to `#121017`, every card keeps its 1px `--clear-line`, and
shadows stay only where a surface overlaps another surface (a popover over a
panel), never where it would fall on the page. §13's other rules apply intact:
no pure `#fff` text, dither large soft gradients, nothing large/bright/fixed.
The light variant is unchanged and remains the default.

### 14.2 Clear components

- **Panel / flyout** — `--clear-surface`, `--clear-r-panel`, `--clear-line`
  border, `--clear-shadow-pop`; opens with a corner-anchored spring pop.
- **Tile / card** — `--clear-tile` fill, `--clear-r-card`, `--clear-line`
  border, `--clear-shadow-card`; hover lifts to `--clear-surface` and warms the
  border toward `--violet-soft`; press scales `0.98`. Icon well is a
  `--violet-soft` rounded square holding a stroked violet glyph.
- **Primary button** — violet→`--violet-2` gradient, `--clear-r-control`, white
  text, gentle brighten on hover, `0.98` press. Exactly one per view.
- **Secondary / ghost** — transparent or `--clear-tile`, `--clear-line` border,
  ink text.
- **Chip / status** — pill (`--clear-r-chip`), soft-tinted status backgrounds
  (`--clear-good-soft` etc.). This is where §2's pill ban is deliberately lifted.
- **Input** — `--clear-surface`, `--clear-line` border → `--violet` +
  `--clear-focus` on focus. Never a bare outline.
- **Row / list** — hairline-separated, generous vertical padding on the 8px
  grid; hover tints to `--clear-tile`.

### 14.3 Clear review checklist

- [ ] Ground is a chosen off-white (faint violet bias), never flat grey — and a
      real dark variant exists, grounded at `#000000` with hairlines carrying
      the separation that shadow cannot on black.
- [ ] Body text clears WCAG AA against its own surface in BOTH themes — Clear is
      chosen for legibility, so this is the checklist item that outranks taste.
- [ ] Depth reads from soft shadow + 1px solid hairline; no lit gradient edges,
      no synthesized glass.
- [ ] Violet appears only on actions, the active/selected state, focus, and the
      mark — surfaces stay neutral; no violet field.
- [ ] Corners are rounded (9–20px band); pills used only for chips/toggles.
- [ ] One primary (violet) button per view; everything else neutral.
- [ ] Text is `--clear-ink`, never pure `#000` on `#fff`; contrast ≥ WCAG AA.
- [ ] Motion is a calm spring pop + crossfades; no specular sheen; reduced
      motion fully honoured.
- [ ] Both themes defined at token level; `body` paints an explicit token
      background (a transparent body borrows the host ground).
- [ ] Nothing from the deep-space sheet (glass tiers, nebula, angular radii)
      leaked into a Clear surface.
- [ ] Copy is sentence-case, concrete, tells the user what to do next (shared §9).
