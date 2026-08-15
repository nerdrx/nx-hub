"use strict";
// src/cli/args.js — the hand-rolled argv parser.

const test = require("node:test");
const assert = require("node:assert");

const { parseArgv } = require("../../src/cli/args");

test("cli/args: command and positionals", () => {
  const p = parseArgv(["install", "wivrn-nx", "apk-adb-android"]);
  assert.equal(p.command, "install");
  assert.deepEqual(p.args, ["wivrn-nx", "apk-adb-android"]);
  assert.deepEqual(p.flags, {});
  assert.deepEqual(p.unknown, []);
});

test("cli/args: the command is lowercased, arguments are not", () => {
  const p = parseArgv(["LIST"]);
  assert.equal(p.command, "list");
  const q = parseArgv(["info", "WiVRn-NX"]);
  assert.deepEqual(q.args, ["WiVRn-NX"]);
});

test("cli/args: boolean flags, negation and =value", () => {
  const p = parseArgv(["list", "--json", "--no-color", "--all=false"]);
  assert.equal(p.flags.json, true);
  assert.equal(p.flags.color, false);
  assert.equal(p.flags.all, false);
});

test("cli/args: value flags take the next token or =value", () => {
  assert.equal(parseArgv(["install", "app", "--tag", "v1.2.3"]).flags.tag, "v1.2.3");
  assert.equal(parseArgv(["install", "app", "--tag=v1.2.3"]).flags.tag, "v1.2.3");
  // a value flag must not swallow the next flag
  const p = parseArgv(["install", "app", "--tag", "--json"]);
  assert.equal(p.flags.tag, "");
  assert.equal(p.flags.json, true);
});

test("cli/args: value flags do not eat positionals meant as commands", () => {
  const p = parseArgv(["install", "--tag", "v1", "wivrn"]);
  assert.equal(p.command, "install");
  assert.deepEqual(p.args, ["wivrn"]);
});

test("cli/args: short flags, including bundles", () => {
  assert.equal(parseArgv(["uninstall", "app", "-y"]).flags.yes, true);
  assert.equal(parseArgv(["help", "-h"]).flags.help, true);
  const bundle = parseArgv(["uninstall", "app", "-yv"]);
  assert.equal(bundle.flags.yes, true);
  assert.equal(bundle.flags.verbose, true);
});

test("cli/args: unknown flags are collected, never guessed at", () => {
  const p = parseArgv(["list", "--jsn", "-Q"]);
  assert.deepEqual(p.unknown, ["--jsn", "-Q"]);
  assert.equal(p.flags.json, undefined);
});

test("cli/args: -- stops flag parsing", () => {
  const p = parseArgv(["launch", "app", "--", "--json"]);
  assert.deepEqual(p.args, ["app", "--json"]);
  assert.equal(p.flags.json, undefined);
});

test("cli/args: empty argv", () => {
  const p = parseArgv([]);
  assert.equal(p.command, null);
  assert.deepEqual(p.args, []);
});
