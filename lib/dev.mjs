import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import profile from '../api/profile.mjs';

const port = Number(process.env.PORT || 3000);
const root = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/setup.html', ['setup.html', 'text/html']],
  ['/dashboard/style.css', ['dashboard/style.css', 'text/css']],
  ['/dashboard/app.mjs', ['dashboard/app.mjs', 'text/javascript']],
  ['/dashboard/model.mjs', ['dashboard/model.mjs', 'text/javascript']],
]);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/profile') {
      const response = await profile.fetch(new Request(url, { method: req.method, headers: req.headers }));
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
