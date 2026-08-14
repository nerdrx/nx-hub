"use strict";
// NX Hub — e2e hooks (only when NX_HUB_E2E=1). HTTP on 127.0.0.1:9020.
// Mirrors PulseNX's e2e server. Never enabled in normal runs.

const http = require("http");
const { URL } = require("url");

const config = require("./config");
const ipc = require("./ipc");
const discovery = require("./discovery");
const jobs = require("./jobs");

const PORT = Number(process.env.NX_HUB_E2E_PORT || 9020);
const HOST = "127.0.0.1";

let server = null;
let deps = { getWindow: () => null };

function enabled() {
  return process.env.NX_HUB_E2E === "1";
}

function send(res, code, body, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(payload);
}

async function win() {
  const w = deps.getWindow();
  if (!w || w.isDestroyed()) throw new Error("no window");
  return w;
}

async function handle(req, res, url) {
  const p = url.pathname;

  if (p === "/health") return send(res, 200, { ok: true, pid: process.pid });

  if (p === "/state") return send(res, 200, await ipc.buildState());

  if (p === "/dom") {
    const w = await win();
    const html = await w.webContents.executeJavaScript("document.documentElement.outerHTML");
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  if (p === "/screenshot") {
    const w = await win();
    const image = await w.webContents.capturePage();
    const png = image.toPNG();
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store" });
    return res.end(png);
  }

  if (p === "/click") {
    const sel = url.searchParams.get("sel");
    if (!sel) return send(res, 400, { error: "sel required" });
    const w = await win();
    const clicked = await w.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`
    );
    return send(res, clicked ? 200 : 404, { clicked });
  }

  if (p === "/refresh") {
    await discovery.refresh({ force: true });
    return send(res, 200, { ok: true, apps: discovery.getCached().apps.length });
  }

  // --- test-only conveniences (drive jobs without depending on UI selectors) ---
  if (p === "/install" || p === "/uninstall") {
    const appId = url.searchParams.get("appId");
    const artifactId = url.searchParams.get("artifactId");
    if (!appId || !artifactId) return send(res, 400, { error: "appId and artifactId required" });
    const jobId = p === "/install" ? jobs.install(appId, artifactId) : jobs.uninstall(appId, artifactId);
    return send(res, 200, { jobId });
  }

  // v0.2: install a specific tag / roll back to the kept previous version
  if (p === "/installVersion" || p === "/rollback") {
    const appId = url.searchParams.get("appId");
    const artifactId = url.searchParams.get("artifactId");
    if (!appId || !artifactId) return send(res, 400, { error: "appId and artifactId required" });
    if (p === "/rollback") return send(res, 200, { jobId: jobs.rollback(appId, artifactId) });
    const tag = url.searchParams.get("tag");
    if (!tag) return send(res, 400, { error: "tag required" });
    return send(res, 200, { jobId: jobs.installVersion(appId, artifactId, tag) });
  }

  if (p === "/releases") {
    const appId = url.searchParams.get("appId");
    if (!appId) return send(res, 400, { error: "appId required" });
    return send(res, 200, await ipc.getReleases(appId));
  }

  if (p === "/job") {
    const id = url.searchParams.get("id");
    const job = jobs.list().find((j) => j.id === id);
    return send(res, job ? 200 : 404, job || { error: "no such job" });
  }

  if (p === "/jobs") return send(res, 200, jobs.list());

  return send(res, 404, { error: `no route ${p}` });
}

function start(d = {}) {
  deps = Object.assign(deps, d);
  if (!enabled() || server) return null;
  server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${PORT}`);
    } catch (e) {
      return send(res, 400, { error: "bad url" });
    }
    Promise.resolve()
      .then(() => handle(req, res, url))
      .catch((err) => {
        try {
          send(res, 500, { error: err.message });
        } catch (_) {
          /* response already sent */
        }
      });
  });
  server.on("error", (err) => config.log(`e2e server error: ${err.message}`));
  server.listen(PORT, HOST, () => config.log(`e2e hooks listening on http://${HOST}:${PORT}`));
  return server;
}

function stop() {
  if (server) {
    try {
      server.close();
    } catch (_) {
      /* ignore */
    }
    server = null;
  }
}

module.exports = { start, stop, enabled, PORT };
