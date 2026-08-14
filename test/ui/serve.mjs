// Zero-dependency static server for screenshotting the renderer standalone
// (mock mode). Module scripts are blocked over file:// in Chromium, so the
// orchestrator serves the folder instead:
//
//   node test/ui/serve.mjs 8099   →   http://127.0.0.1:8099/
//
// Import-safe: it only listens when executed directly, so `node --test test/ui`
// never starts a server.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

export function createRendererServer(root = ROOT) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const path = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!path.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        'content-type': TYPES[extname(path)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
}

if (!process.env.NODE_TEST_CONTEXT) {
  const port = Number(process.argv[2]) || 8099;
  createRendererServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`nx-hub renderer (mock mode) on http://127.0.0.1:${port}/\n`);
  });
}
