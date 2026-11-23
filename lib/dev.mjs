import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import profile from '../api/profile.mjs';

const port = Number(process.env.PORT || 3000);
const root = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/setup.html', ['setup.html', 'text/html']],
  ['/connect.html', ['connect.html', 'text/html']],
  ['/dashboard/connect.mjs', ['dashboard/connect.mjs', 'text/javascript']],
  ['/dashboard/style.css', ['dashboard/style.css', 'text/css']],
  ['/dashboard/after-hours.svg', ['dashboard/after-hours.svg', 'image/svg+xml']],
  ['/dashboard/theme.js', ['dashboard/theme.js', 'text/javascript']],
  ['/dashboard/profile-pixel.woff2', ['dashboard/profile-pixel.woff2', 'font/woff2']],
  ['/dashboard/app.mjs', ['dashboard/app.mjs', 'text/javascript']],
  ['/dashboard/model.mjs', ['dashboard/model.mjs', 'text/javascript']],
  ['/dashboard/dissolve.mjs', ['dashboard/dissolve.mjs', 'text/javascript']],
  ['/dashboard/dissolve-LICENSE.txt', ['dashboard/dissolve-LICENSE.txt', 'text/plain']],
]);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/profile') {
      const body = req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {};
      const response = await profile.fetch(new Request(url, { method: req.method, headers: req.headers, ...body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { res.writeHead(404).end(); return; }
    const [file, type] = asset;
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(await readFile(new URL(file, root)));
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
