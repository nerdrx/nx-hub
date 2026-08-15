"use strict";
// Entry point so `node --test test/cli` works on Node >= 24, where a bare
// directory only resolves through its index.js (same shape as test/core).

const fs = require("fs");
const path = require("path");

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith(".test.js")) require(path.join(__dirname, file));
}
