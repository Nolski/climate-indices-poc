// Fetches the first load from a running server through a deliberately slow link and times it.
//   node web/tests/slow_link.mjs http://127.0.0.1:8000 [kbit/s=400] [round-trip ms=400]
//
// What is simulated: one shared downlink of the given speed for all connections, a round trip
// of delay for every request, and one more for each new connection (up to 6 in parallel, like a
// browser on HTTP/1.1). Requests go out in the order a browser would send them:
//   1. the page;  2. stylesheet, modules and interface text, in parallel;  3. the first API calls.
// What is not simulated: script start-up and drawing, packet loss, and TCP slow start.
// Output is one JSON object on the last line.
import http from 'node:http';
import zlib from 'node:zlib';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8000');
const kbps = Number(process.argv[3] || 400);
const rtt = Number(process.argv[4] || 400);
const bytesPerMs = (kbps * 1000) / 8 / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the slow link: a proxy in front of the real server
const queue = [];
let budget = 0;
let last = Date.now();
const pump = setInterval(() => {
  const now = Date.now();
  budget = Math.min(budget + (now - last) * bytesPerMs, bytesPerMs * 100);
  last = now;
  while (queue.length && budget >= queue[0].cost) {
    const item = queue.shift();
    budget -= item.cost;
    if (item.chunk.length) item.res.write(item.chunk);
    if (item.end) item.res.end();
  }
}, 5);

const fresh = new WeakSet();
const proxy = http.createServer(async (req, res) => {
  await sleep(rtt + (fresh.has(req.socket) ? 0 : rtt));
  fresh.add(req.socket);
  const up = http.request({ host: base.hostname, port: base.port, path: req.url, method: req.method, headers: { ...req.headers, host: base.host } }, (upRes) => {
    const parts = [];
    upRes.on('data', (c) => parts.push(c));
    upRes.on('end', () => {
      const body = Buffer.concat(parts);
      const headers = { ...upRes.headers };
      delete headers['transfer-encoding'];
      headers['content-length'] = body.length;
      res.writeHead(upRes.statusCode, headers);
      queue.push({ res, chunk: Buffer.alloc(0), cost: 300, end: body.length === 0 }); // response headers also cross the link
      for (let i = 0; i < body.length; i += 1024) {
        const chunk = body.subarray(i, Math.min(i + 1024, body.length));
        queue.push({ res, chunk, cost: chunk.length, end: i + 1024 >= body.length });
      }
    });
  });
  up.on('error', () => {
    res.statusCode = 502;
    res.end();
  });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const port = proxy.address().port;

// ---- the "browser"
const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent, headers: { 'accept-encoding': 'gzip, br' } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        const enc = res.headers['content-encoding'] || '';
        let body = raw;
        try {
          if (enc === 'br') body = zlib.brotliDecompressSync(raw);
          else if (enc === 'gzip') body = zlib.gunzipSync(raw);
        } catch {
          body = raw;
        }
        resolve({ path, status: res.statusCode, wire: raw.length, encoding: enc || 'none', text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
  });
}

const t0 = Date.now();
const at = () => Date.now() - t0;
const page = await get('/');
const tPage = at();
const refs = [...page.text.matchAll(/<link rel="(stylesheet|modulepreload|preload)" href="([^"]+)"/g)].map((m) => ({ rel: m[1], href: m[2] }));
let tStyle = 0;
const wave2 = await Promise.all(
  refs.map(async (r) => {
    const out = await get('/' + r.href);
    if (r.rel === 'stylesheet') tStyle = at();
    return out;
  }),
);
const tAssets = at();
const wave3 = await Promise.all([get('/api/version'), get('/api/indices')]);
const tData = at();

clearInterval(pump);
agent.destroy();
proxy.close();
const all = [page, ...wave2, ...wave3];
const bad = all.filter((r) => r.status !== 200).map((r) => r.path + ' ' + r.status);
console.log(
  JSON.stringify({
    kbps,
    rtt,
    requests: all.length,
    wireBytes: all.reduce((s, r) => s + r.wire, 0),
    shellWireBytes: [page, ...wave2].reduce((s, r) => s + r.wire, 0),
    encodings: [...new Set(all.map((r) => r.encoding))],
    pageMs: tPage,
    styledMs: tStyle,
    assetsMs: tAssets,
    dataMs: tData,
    failed: bad,
  }),
);
process.exit(bad.length ? 1 : 0);
