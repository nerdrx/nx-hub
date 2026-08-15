"use strict";
// NX Hub — connector barrel, so `require("./connector")` and
// `require("./connector/server")` both give the frozen module API.
module.exports = require("./server");
