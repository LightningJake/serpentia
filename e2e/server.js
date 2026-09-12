/* Shared static server for the e2e suites. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};

function serve(port) {
  return http
    .createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      fs.readFile(f, (e, d) => {
        if (e) {
          res.writeHead(404);
          res.end('nf');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
        res.end(d);
      });
    })
    .listen(port);
}

module.exports = { serve, ROOT };
