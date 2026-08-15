// Barrel for `node --test test/ui`.
//
// Node 26 no longer expands a bare directory argument into its test files — it
// resolves the directory as a module instead. Importing every suite here keeps
// the documented command working; each *.test.js still runs standalone
// (`node --test test/ui/*.test.js`).

import './version.test.js';
import './markdown.test.js';
import './actions.test.js';
import './model.test.js';
import './render.test.js';
import './launcher.test.js';
// v0.2
import './prefs.test.js';
import './releases.test.js';
import './devices.test.js';
import './storage.test.js';
import './sheets.test.js';
// v0.5 — the connector bus and stacks
import './connector.test.js';
import './stacks.test.js';
// Last on purpose: this one installs a stub DOM on globalThis and boots app.js.
import './smoke.test.js';
