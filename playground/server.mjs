// Static server for the local mock platforms. Dependency-free so tests can start it directly.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function startPlayground(port = 5199) {
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, path);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', async (error) => {
      // Reuse a playground that's already running, so tests can run alongside `pnpm playground`.
      if (error.code !== 'EADDRINUSE') return reject(error);
      const running = await fetch(`http://127.0.0.1:${port}/shared/mock.css`).catch(() => null);
      if (running?.ok) resolve({ close: (done) => done?.() });
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startPlayground();
  console.log('Sima playground on http://localhost:5199');
}
