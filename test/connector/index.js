"use strict";
// Entry point so `node --test test/connector` works on Node >= 24, where a bare
// directory only resolves through its index.js (see test/core/index.js).
// Running `node --test test/connector/*.test.js` or a single file still works.

const fs = require("fs");
const path = require("path");

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith(".test.js")) require(path.join(__dirname, file));
}
