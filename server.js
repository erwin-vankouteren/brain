// Personal Brain — local server. Listens on 127.0.0.1 only; data stays on this machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Brain, HttpError, KINDS, SOURCES } from './src/db.js';
import { parseFile, SUPPORTED, IMAGE_EXT } from './src/importers.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRAIN_PORT || 4321);
const DB_FILE = process.env.BRAIN_DB || path.join(ROOT, 'data', 'brain.db');
const FILES_DIR = path.join(path.dirname(DB_FILE), 'files');
const WATCH_DIR = process.env.BRAIN_WATCH || path.join(ROOT, 'inbox');
const PUBLIC = path.join(ROOT, 'public');

const brain = new Brain(DB_FILE);
fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------- import (shared by upload + folder watch). The original file is kept in data/files.
async function importFile(name, buf, { thoughtId, mtime } = {}) {
  const ext = path.extname(name).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new HttpError(400, `Unsupported file type "${ext}". Supported: ${SUPPORTED.join(' ')}`);
  const safe = path.basename(name).replace(/[^\w.\- ()]+/g, '_').slice(-120);
  const tmp = path.join(FILES_DIR, `tmp-${process.hrtime.bigint()}${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    const parsed = await parseFile(name, buf, { mtime, filePath: tmp });
    const thoughtIds = thoughtId ? [Number(thoughtId)] : [];
    const item = brain.createItem({ ...parsed, thoughtIds, status: thoughtIds.length ? 'filed' : 'inbox' });
    const stored = `${item.id}-${safe}`;
    fs.renameSync(tmp, path.join(FILES_DIR, stored));
    return brain.setItemFile(item.id, stored);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// ---------- routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
const id = v => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, 'Bad id'); return n; };

route('GET', '/api/meta', () => ({ kinds: KINDS, sources: SOURCES, supported: SUPPORTED, watchDir: WATCH_DIR }));
route('GET', '/api/stats', () => brain.stats());
route('GET', '/api/search', (_, q) => brain.search(q.get('q')));

route('GET', '/api/thoughts', (_, q) => brain.listThoughts(q.get('q') || '', Number(q.get('limit') || 20)));
route('POST', '/api/thoughts', ({ body }) => brain.createThought(body.name, body.kind));
route('GET', '/api/thoughts/:id', ({ p }) => brain.getThought(p.id === 'home' ? brain.homeId() : id(p.id)));
route('PATCH', '/api/thoughts/:id', ({ p, body }) => brain.updateThought(id(p.id), body));
route('DELETE', '/api/thoughts/:id', ({ p }) => brain.deleteThought(id(p.id)));
route('POST', '/api/thoughts/:id/home', ({ p }) => (brain.setHome(id(p.id)), { ok: true }));

route('POST', '/api/thoughts/:id/weblinks', ({ p, body }) => brain.addWeblink(id(p.id), body));
route('PATCH', '/api/weblinks/:id', ({ p, body }) => brain.updateWeblink(id(p.id), body));
route('DELETE', '/api/weblinks/:id', ({ p }) => brain.deleteWeblink(id(p.id)));
// Browsers can't open local files from a web page, so the server opens a *saved* file link in its default app.
route('POST', '/api/weblinks/:id/open', ({ p, body }) => {
  const l = brain.getWeblink(id(p.id));
  if (l.kind !== 'file') throw new HttpError(400, 'Not a file link');
  if (!fs.existsSync(l.url)) throw new HttpError(404, `File not found: ${l.url}`);
  const args = body.reveal ? [`/select,${l.url}`] : [l.url];
  spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true };
});

route('POST', '/api/links',({ body }) => brain.link(id(body.from), id(body.to), body.rel));
route('DELETE', '/api/links/:a/:b', ({ p }) => brain.unlink(id(p.a), id(p.b)));

route('GET', '/api/items', (_, q) => brain.listItems({ status: q.get('status') || undefined }));
route('POST', '/api/items', ({ body }) => brain.createItem(body));
route('GET', '/api/items/:id', ({ p }) => brain.getItem(id(p.id)));
route('PATCH', '/api/items/:id', ({ p, body }) => brain.updateItem(id(p.id), body));
route('DELETE', '/api/items/:id', ({ p }) => {
  const r = brain.deleteItem(id(p.id));
  if (r.file) fs.rmSync(path.join(FILES_DIR, path.basename(r.file)), { force: true });
  return { ok: true };
});
route('GET', '/api/items/:id/file', ({ p, res }) => {
  const it = brain.getItem(id(p.id));
  const full = it.file && path.join(FILES_DIR, path.basename(it.file));
  if (!full || !fs.existsSync(full)) throw new HttpError(404, 'Original file not available');
  const ext = path.extname(full).toLowerCase();
  const inline = ['.pdf', '.txt', '.md', '.log', ...IMAGE_EXT].includes(ext);
  const name = it.file.replace(/^\d+-/, '');
  res.writeHead(200, {
    'Content-Type': FILE_MIME[ext] || 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    // lock down text/images; PDFs are left to the browser's own (sandboxed) PDF viewer
    ...(ext === '.pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
  });
  fs.createReadStream(full).pipe(res);
  return RAW;
});
route('POST', '/api/items/:id/thoughts/:tid', ({ p }) => brain.attachItem(id(p.id), id(p.tid)));
route('DELETE', '/api/items/:id/thoughts/:tid', ({ p }) => brain.detachItem(id(p.id), id(p.tid)));

route('GET', '/api/actions', (_, q) => brain.listActions({ status: q.get('status') || undefined }));
route('POST', '/api/actions', ({ body }) => brain.createAction(body));
route('PATCH', '/api/actions/:id', ({ p, body }) => brain.updateAction(id(p.id), body));
route('DELETE', '/api/actions/:id', ({ p }) => brain.deleteAction(id(p.id)));
route('POST', '/api/actions/:id/thoughts/:tid', ({ p }) => brain.attachAction(id(p.id), id(p.tid)));
route('DELETE', '/api/actions/:id/thoughts/:tid', ({ p }) => brain.detachAction(id(p.id), id(p.tid)));

route('POST', '/api/import', ({ raw }, q) => {
  const name = q.get('name');
  if (!name) throw new HttpError(400, 'name is required');
  return importFile(name, raw, { thoughtId: q.get('thought') || undefined })
    .catch(e => { throw e instanceof HttpError ? e : new HttpError(400, e.message); });
});

// ---------- http plumbing
const RAW = Symbol('response already sent');
const FILE_MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook', '.vtt': 'text/vtt',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const MIME ={ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

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
    send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message });
  }
});

// ---------- folder watch: drop files in ./inbox, they become inbox items
function startWatcher() {
  const done = path.join(WATCH_DIR, '_imported');
  const failed = path.join(WATCH_DIR, '_failed');
  for (const d of [WATCH_DIR, done, failed]) fs.mkdirSync(d, { recursive: true });
  const seen = new Map(); // name -> size at last poll, so we only import files that stopped growing
  let busy = false;       // OCR can take a while; never run two polls at once
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await poll(); } finally { busy = false; }
  }, 2000);
  async function poll() {
    let names;
    try { names = fs.readdirSync(WATCH_DIR); } catch { return; }
    for (const name of names) {
      const full = path.join(WATCH_DIR, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || name.startsWith('~$') || name.startsWith('.')) continue;
      if (!SUPPORTED.includes(path.extname(name).toLowerCase())) continue;
      if (seen.get(name) !== st.size) { seen.set(name, st.size); continue; }
      seen.delete(name);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      try {
        const item = await importFile(name, fs.readFileSync(full), { mtime: st.mtime });
        fs.renameSync(full, path.join(done, `${stamp}_${name}`));
        console.log(`[watch] imported "${name}" -> inbox item #${item.id}`);
      } catch (e) {
        console.warn(`[watch] could not import "${name}": ${e.message}`);
        try { fs.renameSync(full, path.join(failed, `${stamp}_${name}`)); } catch {}
      }
    }
  }
}

startWatcher();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Brain is running:  http://localhost:${PORT}`);
  console.log(`Database:          ${DB_FILE}`);
  console.log(`Watched folder:    ${WATCH_DIR}  (${SUPPORTED.join(' ')})`);
});
