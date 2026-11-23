// Personal Brain — local server. Listens on 127.0.0.1 only.
// Serves several brains: local ones (SQLite on this machine) and cloud ones (Azure SQL). See src/brains.js.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { HttpError, KINDS, SOURCES } from './src/db.js';
import { parseFile, SUPPORTED, IMAGE_EXT } from './src/importers.js';
import { BrainManager } from './src/brains.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRAIN_PORT || 4321);
const PUBLIC = path.join(ROOT, 'public');
const TMP = path.join(os.tmpdir(), 'brain-import');
fs.mkdirSync(TMP, { recursive: true });

// BRAIN_HOME: folder that holds brains.json, data\ and the inbox folders (default: the app folder)
const brains = new BrainManager(process.env.BRAIN_HOME ? path.resolve(process.env.BRAIN_HOME) : ROOT);

// ---------- import (shared by upload + folder watch). The original file is kept by the brain's file store.
async function importFile(ctx, name, buf, { thoughtId, mtime } = {}) {
  const ext = path.extname(name).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new HttpError(400, `Unsupported file type "${ext}". Supported: ${SUPPORTED.join(' ')}`);
  const tmp = path.join(TMP, `${process.hrtime.bigint()}${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    const parsed = await parseFile(name, buf, { mtime, filePath: tmp });
    const thoughtIds = thoughtId ? [Number(thoughtId)] : [];
    const item = await ctx.brain.createItem({ ...parsed, thoughtIds, status: thoughtIds.length ? 'filed' : 'inbox' });
    const stored = await ctx.files.save(item.id, name, tmp);
    return ctx.brain.setItemFile(item.id, stored);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
// Brain-scoped route: /api/b/<brainId>/...  ctx = { brain, files, cfg }
const broute = (method, pattern, fn) => route(method, '/api/b/:brainId' + pattern, async (args, q) => fn({ ...args, ctx: await brains.get(args.p.brainId) }, q));
const id = v => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, 'Bad id'); return n; };

route('GET', '/api/meta', () => ({ kinds: KINDS, sources: SOURCES, supported: SUPPORTED }));
route('GET', '/api/brains', () => brains.list());
route('POST', '/api/brains', async ({ body }) => { const b = await brains.create(body); return b; });
route('PATCH', '/api/brains/:id', ({ p, body }) => brains.update(p.id, body));
route('DELETE', '/api/brains/:id', ({ p }) => brains.remove(p.id));

broute('GET', '/stats', ({ ctx }) => ctx.brain.stats());
broute('GET', '/search', ({ ctx }, q) => ctx.brain.search(q.get('q'), { limit: Number(q.get('limit')) || 100 }));

broute('GET', '/thoughts', ({ ctx }, q) => ctx.brain.listThoughts(q.get('q') || '', Number(q.get('limit') || 20)));
broute('POST', '/thoughts', ({ ctx, body }) => ctx.brain.createThought(body.name, body.kind));
broute('GET', '/thoughts/:id', async ({ ctx, p }) => ctx.brain.getThought(p.id === 'home' ? await ctx.brain.homeId() : id(p.id)));
broute('PATCH', '/thoughts/:id', ({ ctx, p, body }) => ctx.brain.updateThought(id(p.id), body));
broute('DELETE', '/thoughts/:id', ({ ctx, p }) => ctx.brain.deleteThought(id(p.id)));
broute('POST', '/thoughts/:id/home', async ({ ctx, p }) => { await ctx.brain.setHome(id(p.id)); return { ok: true }; });

broute('POST', '/thoughts/:id/weblinks', ({ ctx, p, body }) => ctx.brain.addWeblink(id(p.id), body));
broute('PATCH', '/weblinks/:id', ({ ctx, p, body }) => ctx.brain.updateWeblink(id(p.id), body));
broute('DELETE', '/weblinks/:id', ({ ctx, p }) => ctx.brain.deleteWeblink(id(p.id)));
// Browsers can't open local files from a web page, so the server opens a *saved* file link in its default app.
broute('POST', '/weblinks/:id/open', async ({ ctx, p, body }) => {
  const l = await ctx.brain.getWeblink(id(p.id));
  if (l.kind !== 'file') throw new HttpError(400, 'Not a file link');
  if (!fs.existsSync(l.url)) throw new HttpError(404, `File not found on this computer: ${l.url}`);
  spawn('explorer.exe', body.reveal ? [`/select,${l.url}`] : [l.url], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

broute('POST', '/links', ({ ctx, body }) => ctx.brain.link(id(body.from), id(body.to), body.rel));
broute('DELETE', '/links/:a/:b', ({ ctx, p }) => ctx.brain.unlink(id(p.a), id(p.b)));

broute('GET', '/items', ({ ctx }, q) => ctx.brain.listItems({ status: q.get('status') || undefined }));
broute('POST', '/items', ({ ctx, body }) => ctx.brain.createItem(body));
broute('GET', '/items/:id', ({ ctx, p }) => ctx.brain.getItem(id(p.id)));
broute('PATCH', '/items/:id', ({ ctx, p, body }) => ctx.brain.updateItem(id(p.id), body));
broute('DELETE', '/items/:id', async ({ ctx, p }) => {
  const r = await ctx.brain.deleteItem(id(p.id));
  await ctx.files.remove(r.file);
  return { ok: true };
});
broute('GET', '/items/:id/file', async ({ ctx, p, res }) => {
  const it = await ctx.brain.getItem(id(p.id));
  const f = await ctx.files.read(it);
  if (!f) throw new HttpError(404, 'Original file not available');
  const ext = path.extname(f.name).toLowerCase();
  const inline = ['.pdf', '.txt', '.md', '.log', ...IMAGE_EXT].includes(ext);
  res.writeHead(200, {
    'Content-Type': FILE_MIME[ext] || 'application/octet-stream',
    'Content-Length': f.data.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600',
    // lock down text/images; PDFs are left to the browser's own (sandboxed) PDF viewer
    ...(ext === '.pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
  });
  res.end(f.data);
  return RAW;
});
broute('POST', '/items/:id/thoughts/:tid', ({ ctx, p }) => ctx.brain.attachItem(id(p.id), id(p.tid)));
broute('DELETE', '/items/:id/thoughts/:tid', ({ ctx, p }) => ctx.brain.detachItem(id(p.id), id(p.tid)));

broute('GET', '/actions', ({ ctx }, q) => ctx.brain.listActions({ status: q.get('status') || undefined }));
broute('POST', '/actions', ({ ctx, body }) => ctx.brain.createAction(body));
broute('PATCH', '/actions/:id', ({ ctx, p, body }) => ctx.brain.updateAction(id(p.id), body));
broute('DELETE', '/actions/:id', ({ ctx, p }) => ctx.brain.deleteAction(id(p.id)));
broute('POST', '/actions/:id/thoughts/:tid', ({ ctx, p }) => ctx.brain.attachAction(id(p.id), id(p.tid)));
broute('DELETE', '/actions/:id/thoughts/:tid', ({ ctx, p }) => ctx.brain.detachAction(id(p.id), id(p.tid)));

broute('POST', '/import', ({ ctx, raw }, q) => {
  const name = q.get('name');
  if (!name) throw new HttpError(400, 'name is required');
  return importFile(ctx, name, raw, { thoughtId: q.get('thought') || undefined })
    .catch(e => { throw e instanceof HttpError ? e : new HttpError(400, e.message); });
});

// ---------- http plumbing
const RAW = Symbol('response already sent');
const FILE_MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook', '.vtt': 'text/vtt',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 50e6) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // Only answer to our own local names (blocks DNS-rebinding from malicious websites).
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) throw new HttpError(403, 'Forbidden host');
    if (url.pathname.startsWith('/api/')) {
      // Reject cross-site requests (another website trying to talk to localhost).
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
      const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'Not found');
      const p = url.pathname.match(r.re).groups || {};
      for (const k in p) p[k] = decodeURIComponent(p[k]);
      const raw = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
      let body = {};
      if (raw.length && (req.headers['content-type'] || '').includes('application/json')) body = JSON.parse(raw.toString('utf8'));
      const out = await r.fn({ p, body, raw, res }, url.searchParams);
      if (out !== RAW) send(res, 200, out);
      return;
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw new HttpError(404, 'Not found');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (!(e instanceof HttpError) && !(e instanceof SyntaxError)) console.error(e);
    if (res.headersSent) return res.end();
    send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message });
  }
});

// ---------- folder watch: every brain has its own inbox folder; files dropped there become inbox items of that brain
const watched = new Map();   // brainId -> inbox dir
const busy = new Set();
const seen = new Map();      // full path -> size at last poll (only import files that stopped growing)

function syncWatchers() {
  watched.clear();
  for (const b of brains.list()) {
    for (const d of [b.inbox, path.join(b.inbox, '_imported'), path.join(b.inbox, '_failed')]) fs.mkdirSync(d, { recursive: true });
    watched.set(b.id, b.inbox);
  }
}
brains.onChange = syncWatchers;

async function pollBrain(brainId, dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const ready = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || name.startsWith('~$') || name.startsWith('.')) continue;
    if (!SUPPORTED.includes(path.extname(name).toLowerCase())) continue;
    if (seen.get(full) !== st.size) { seen.set(full, st.size); continue; }
    seen.delete(full);
    ready.push({ name, full, st });
  }
  if (!ready.length) return;
  let ctx;
  try { ctx = await brains.get(brainId); }
  catch (e) { console.warn(`[watch:${brainId}] brain not available, will retry: ${e.message}`); return; }
  for (const { name, full, st } of ready) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try {
      const item = await importFile(ctx, name, fs.readFileSync(full), { mtime: st.mtime });
      fs.renameSync(full, path.join(dir, '_imported', `${stamp}_${name}`));
      console.log(`[watch:${brainId}] imported "${name}" -> inbox item #${item.id}`);
    } catch (e) {
      console.warn(`[watch:${brainId}] could not import "${name}": ${e.message}`);
      try { fs.renameSync(full, path.join(dir, '_failed', `${stamp}_${name}`)); } catch {}
    }
  }
}

setInterval(() => {
  for (const [brainId, dir] of watched) {
    if (busy.has(brainId)) continue;      // OCR / cloud calls can take a while; one poll per brain at a time
    busy.add(brainId);
    pollBrain(brainId, dir).finally(() => busy.delete(brainId));
  }
}, 2000);

syncWatchers();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Brain is running:  http://localhost:${PORT}`);
  for (const b of brains.list()) {
    console.log(`  ${b.type === 'local' ? '[local]' : '[azure]'} ${b.name}: ${b.type === 'local' ? b.db : `${b.server}/${b.database}`}`);
    console.log(`          inbox folder: ${b.inbox}`);
  }
});
