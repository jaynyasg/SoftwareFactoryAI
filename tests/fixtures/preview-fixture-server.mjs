/**
 * Throwaway preview fixture for the U6 local-preview e2e.
 *
 * A minimal Node HTTP server (no deps) that stands in for a generated app's
 * preview command. It binds 127.0.0.1 on the port given via `PORT` and reports
 * UNHEALTHY (503) on `/health` until `HEALTHY_AFTER_MS` has elapsed since boot,
 * then flips to HEALTHY (200) — so the preview-server must poll past at least one
 * failing health check before exposing the URL. Any other path returns 200 so the
 * exposed URL serves once ready. Plain `.mjs` so it runs directly under `node`
 * (the direct child process), keeping teardown a single, reliable kill.
 */
/* global process, setTimeout */
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 0);
const healthyAfterMs = Number(process.env.HEALTHY_AFTER_MS ?? 400);
const startedAt = Date.now();

const server = createServer((req, res) => {
  if (req.url === '/health') {
    const healthy = Date.now() - startedAt >= healthyAfterMs;
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'starting' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('AI Services Marketplace preview fixture is running.');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`preview-fixture listening on 127.0.0.1:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  // Force-exit if connections linger so teardown never hangs.
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
