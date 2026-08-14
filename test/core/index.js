"use strict";
// Entry point so `node --test test/core` works on Node >= 24, where positional
// arguments are treated as file/glob paths and bare directories are no longer
// expanded (a directory only resolves through its index.js).
// Running `node --test test/core/*.test.js` or a single file still works.

const fs = require("fs");
const path = require("path");

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith(".test.js")) require(path.join(__dirname, file));
}
