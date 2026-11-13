// A stand-in for the API's own CORS support, for local cross-origin tests only.
//   node web/tests/cors_proxy.mjs <listen port> <upstream API, e.g. http://127.0.0.1:8000> <allowed origin>
// It forwards everything to the upstream API and adds exactly the CORS headers that
// docs/pages-hosting.md asks the real API to send, for the one allowed origin. It also answers
// preflight (OPTIONS) requests itself. Not for production: once the API has
// CLIMPOC_CORS_ORIGINS, run the API directly and delete the need for this.
import http from 'node:http';

const port = Number(process.argv[2]);
const upstream = new URL(process.argv[3]);
const allowed = process.argv[4];
const seen = { preflight: 0, simple: 0, refused: 0 };

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const cors = origin === allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Disposition' } : {};
  if (origin && origin !== allowed) seen.refused += 1;
  if (req.url === '/__seen') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(seen));
  }
  if (req.method === 'OPTIONS') {
    seen.preflight += 1;
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  seen.simple += 1;
  const up = http.request({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (upRes) => {
    res.writeHead(upRes.statusCode, { ...upRes.headers, ...cors });
    upRes.pipe(res);
  });
  up.on('error', () => {
    res.writeHead(502, cors);
    res.end();
  });
  req.pipe(up);
});
server.listen(port, '127.0.0.1', () => console.log('cors proxy on ' + port + ' -> ' + upstream.origin + ' for ' + allowed));
