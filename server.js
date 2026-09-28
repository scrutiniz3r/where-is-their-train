// Static file server for local development. The app calls RailRadar
// directly from the browser (see index.html) — this server has no API
// proxy, so nothing here differs between running it locally and serving
// the same files from GitHub Pages.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8735;

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.join(root, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
      '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
    };
    const type = types[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}).listen(port, () => console.log('listening on ' + port));
