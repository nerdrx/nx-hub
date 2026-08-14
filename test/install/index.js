"use strict";
// Directory entry point for the install-engine test suite.
//
// Node 26 no longer expands a DIRECTORY argument to `node --test` — it resolves
// the path as a module and errors out (ERR_UNSUPPORTED_DIR_IMPORT /
// MODULE_NOT_FOUND). This shim makes the documented commands work again:
//
//   node --test test/install               → resolves to this file, loads every suite
//   node --test 'test/install/*.test.js'   → also fine (this file is not a *.test.js)
//   npm test                               → node --test test/core test/install
//
// Keep it dumb: just require the suites in a stable order.

require("./engine.test.js");
require("./appimage.test.js");
require("./archive-dir.test.js");
require("./tarball-prefix.test.js");
require("./apk-adb.test.js");
require("./kinds.test.js");
