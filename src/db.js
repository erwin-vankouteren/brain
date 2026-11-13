// Data layer: thoughts (topics/people/projects), typed links between them,
// captured items (snippets from mail/Teams/notes/...), and actions (to-dos).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['topic', 'project', 'person', 'org'];
export const SOURCES = ['note', 'meeting', 'teams', 'email', 'whatsapp', 'onenote', 'notepad', 'paper', 'document', 'other'];
export const ACTION_STATUS = ['open', 'waiting', 'done'];

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toLocaleDateString('sv-SE');

export class Brain {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS thoughts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'topic',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        visited_at TEXT
      );
      -- type 'child': a is parent of b. type 'jump': a < b, undirected.
      CREATE TABLE IF NOT EXISTS links (
        a INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        b INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('child','jump')),
        PRIMARY KEY (a, b)
      );
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'note',
        occurred_at TEXT NOT NULL,
        people TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','filed')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS item_thoughts (
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        thought_id INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        PRIMARY KEY (item_id, thought_id)
      );
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','done')),
        due TEXT,
        owner TEXT NOT NULL DEFAULT '',
        item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        done_at TEXT
      );
      CREATE TABLE IF NOT EXISTS action_thoughts (
        action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        thought_id INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        PRIMARY KEY (action_id, thought_id)
      );
      -- links to documents/web pages attached to a thought (url = http(s) URL or local file path)
      CREATE TABLE IF NOT EXISTS weblinks (
        id INTEGER PRIMARY KEY,
        thought_id INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_weblinks_t ON weblinks(thought_id);
      CREATE INDEX IF NOT EXISTS ix_links_b ON links(b);
      CREATE INDEX IF NOT EXISTS ix_item_thoughts_t ON item_thoughts(thought_id);
      CREATE INDEX IF NOT EXISTS ix_action_thoughts_t ON action_thoughts(thought_id);
    `);
    // migration: original imported file stored next to the database
    if (!this.all(`PRAGMA table_info(items)`).some(c => c.name === 'file')) this.db.exec(`ALTER TABLE items ADD COLUMN file TEXT`);
    if (!this.homeId()) {
      const id = this.createThought('My Brain', 'topic').id;
      this.run(`INSERT OR REPLACE INTO meta(key,value) VALUES('home',?)`, String(id));
    }
  }

  // ---- helpers
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  run(sql, ...p) { return this.db.prepare(sql).run(...p); }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  homeId() { const r = this.get(`SELECT value FROM meta WHERE key='home'`); return r ? Number(r.value) : null; }
  setHome(id) { this.mustThought(id); this.run(`INSERT OR REPLACE INTO meta(key,value) VALUES('home',?)`, String(id)); }
  mustThought(id) {
    const t = this.get(`SELECT id,name,kind,notes,created_at,updated_at FROM thoughts WHERE id=?`, id);
    if (!t) throw new HttpError(404, 'Thought not found');
    return t;
  }

  // ---- thoughts
  listThoughts(q = '', limit = 20) {
    q = q.trim();
    if (!q) return this.all(`SELECT id,name,kind FROM thoughts ORDER BY COALESCE(visited_at, updated_at) DESC LIMIT ?`, limit);
    return this.all(
      `SELECT id,name,kind FROM thoughts WHERE name LIKE ? ORDER BY (lower(name)=lower(?)) DESC, (name LIKE ?) DESC, length(name), name LIMIT ?`,
      `%${q}%`, q, `${q}%`, limit);
  }

  createThought(name, kind = 'topic') {
    name = String(name || '').trim();
    if (!name) throw new HttpError(400, 'Name is required');
    if (!KINDS.includes(kind)) kind = 'topic';
    const existing = this.get(`SELECT id,name,kind FROM thoughts WHERE lower(name)=lower(?)`, name);
    if (existing) return existing;
    const r = this.run(`INSERT INTO thoughts(name,kind,created_at,updated_at) VALUES(?,?,?,?)`, name, kind, now(), now());
    return { id: Number(r.lastInsertRowid), name, kind };
  }

  getThought(id) {
    const t = this.mustThought(id);
    this.run(`UPDATE thoughts SET visited_at=? WHERE id=?`, now(), id);
    const cols = `t.id, t.name, t.kind`;
    const parents = this.all(`SELECT ${cols} FROM links l JOIN thoughts t ON t.id=l.a WHERE l.b=? AND l.type='child' ORDER BY t.name`, id);
    const children = this.all(`SELECT ${cols} FROM links l JOIN thoughts t ON t.id=l.b WHERE l.a=? AND l.type='child' ORDER BY t.name`, id);
    const jumps = this.all(`SELECT ${cols} FROM links l JOIN thoughts t ON t.id = CASE WHEN l.a=? THEN l.b ELSE l.a END
                            WHERE l.type='jump' AND (l.a=? OR l.b=?) ORDER BY t.name`, id, id, id);
    const siblings = this.all(`SELECT DISTINCT ${cols} FROM links p JOIN links s ON s.a=p.a AND s.type='child'
                               JOIN thoughts t ON t.id=s.b
                               WHERE p.b=? AND p.type='child' AND s.b<>? ORDER BY t.name LIMIT 40`, id, id);
    const items = this.withItemThoughts(this.all(
      `SELECT i.* FROM items i JOIN item_thoughts it ON it.item_id=i.id WHERE it.thought_id=? ORDER BY i.occurred_at DESC, i.id DESC`, id));
    const actions = this.withActionThoughts(this.all(
      `SELECT a.*, i.title AS item_title FROM actions a JOIN action_thoughts at ON at.action_id=a.id
       LEFT JOIN items i ON i.id=a.item_id WHERE at.thought_id=?
       ORDER BY (a.status='done'), COALESCE(a.due,'9999'), a.id`, id));
    const weblinks = this.all(`SELECT * FROM weblinks WHERE thought_id=? ORDER BY lower(title), id`, id).map(withKind);
    return { ...t, isHome: id === this.homeId(), parents, children, jumps, siblings, items, actions, weblinks };
  }

  // ---- links to documents / web pages
  getWeblink(id) {
    const l = this.get(`SELECT * FROM weblinks WHERE id=?`, id);
    if (!l) throw new HttpError(404, 'Link not found');
    return withKind(l);
  }
  addWeblink(thoughtId, { url, title }) {
    this.mustThought(thoughtId);
    url = normalizeUrl(url);
    title = String(title || '').trim() || guessTitle(url);
    const r = this.run(`INSERT INTO weblinks(thought_id,url,title,created_at) VALUES(?,?,?,?)`, thoughtId, url, title, now());
    return this.getWeblink(Number(r.lastInsertRowid));
  }
  updateWeblink(id, { url, title }) {
    const cur = this.getWeblink(id);
    if (url !== undefined) this.run(`UPDATE weblinks SET url=? WHERE id=?`, normalizeUrl(url), id);
    if (title !== undefined) this.run(`UPDATE weblinks SET title=? WHERE id=?`, String(title).trim() || guessTitle(url ? normalizeUrl(url) : cur.url), id);
    return this.getWeblink(id);
  }
  deleteWeblink(id) { this.run(`DELETE FROM weblinks WHERE id=?`, id); return { ok: true }; }

  updateThought(id, { name, kind, notes }) {
    this.mustThought(id);
    if (name !== undefined) {
      name = String(name).trim();
      if (!name) throw new HttpError(400, 'Name is required');
      const clash = this.get(`SELECT id FROM thoughts WHERE lower(name)=lower(?) AND id<>?`, name, id);
      if (clash) throw new HttpError(409, `A thought named "${name}" already exists`);
      this.run(`UPDATE thoughts SET name=? WHERE id=?`, name, id);
    }
    if (kind !== undefined && KINDS.includes(kind)) this.run(`UPDATE thoughts SET kind=? WHERE id=?`, kind, id);
    if (notes !== undefined) this.run(`UPDATE thoughts SET notes=? WHERE id=?`, String(notes), id);
    this.run(`UPDATE thoughts SET updated_at=? WHERE id=?`, now(), id);
    return this.mustThought(id);
  }

  deleteThought(id) {
    if (id === this.homeId()) throw new HttpError(400, 'The home thought cannot be deleted');
    this.mustThought(id);
    this.run(`DELETE FROM thoughts WHERE id=?`, id);
    return { ok: true };
  }

  // rel describes `to` relative to `from`: 'parent' | 'child' | 'jump'
  link(from, to, rel) {
    if (from === to) throw new HttpError(400, 'Cannot link a thought to itself');
    this.mustThought(from); this.mustThought(to);
    return this.tx(() => {
      this.unlink(from, to);
      if (rel === 'child') this.run(`INSERT INTO links(a,b,type) VALUES(?,?,'child')`, from, to);
      else if (rel === 'parent') this.run(`INSERT INTO links(a,b,type) VALUES(?,?,'child')`, to, from);
      else if (rel === 'jump') this.run(`INSERT INTO links(a,b,type) VALUES(?,?,'jump')`, Math.min(from, to), Math.max(from, to));
      else throw new HttpError(400, 'rel must be parent, child or jump');
      return { ok: true };
    });
  }
  unlink(a, b) {
    this.run(`DELETE FROM links WHERE (a=? AND b=?) OR (a=? AND b=?)`, a, b, b, a);
    return { ok: true };
  }

  // ---- items
  withItemThoughts(items) {
    const q = this.db.prepare(`SELECT t.id,t.name,t.kind FROM item_thoughts it JOIN thoughts t ON t.id=it.thought_id WHERE it.item_id=? ORDER BY t.name`);
    const qa = this.db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE item_id=? AND status<>'done'`);
    return items.map(i => ({ ...i, thoughts: q.all(i.id), openActions: qa.get(i.id).n }));
  }
  getItem(id) {
    const i = this.get(`SELECT * FROM items WHERE id=?`, id);
    if (!i) throw new HttpError(404, 'Item not found');
    return this.withItemThoughts([i])[0];
  }
  listItems({ status } = {}) {
    const rows = status
      ? this.all(`SELECT * FROM items WHERE status=? ORDER BY occurred_at DESC, id DESC`, status)
      : this.all(`SELECT * FROM items ORDER BY occurred_at DESC, id DESC LIMIT 500`);
    return this.withItemThoughts(rows);
  }
  createItem(d) {
    const source = SOURCES.includes(d.source) ? d.source : 'other';
    let title = String(d.title || '').trim();
    const body = String(d.body || '');
    if (!title) title = (body.split('\n').find(l => l.trim()) || 'Untitled').trim().slice(0, 120);
    const thoughtIds = (d.thoughtIds || []).map(Number);
    const status = d.status === 'filed' || d.status === 'inbox' ? d.status : (thoughtIds.length ? 'filed' : 'inbox');
    return this.tx(() => {
      const r = this.run(`INSERT INTO items(title,body,source,occurred_at,people,origin,status,created_at) VALUES(?,?,?,?,?,?,?,?)`,
        title, body, source, d.occurred_at || today(), String(d.people || ''), String(d.origin || ''), status, now());
      const id = Number(r.lastInsertRowid);
      for (const t of thoughtIds) this.attachItem(id, t);
      return this.getItem(id);
    });
  }
  updateItem(id, d) {
    this.getItem(id);
    for (const f of ['title', 'body', 'source', 'occurred_at', 'people', 'status']) {
      if (d[f] === undefined) continue;
      if (f === 'source' && !SOURCES.includes(d[f])) continue;
      if (f === 'status' && !['inbox', 'filed'].includes(d[f])) continue;
      this.run(`UPDATE items SET ${f}=? WHERE id=?`, String(d[f]), id);
    }
    if (Array.isArray(d.thoughtIds)) {
      this.run(`DELETE FROM item_thoughts WHERE item_id=?`, id);
      for (const t of d.thoughtIds) this.attachItem(id, Number(t));
    }
    return this.getItem(id);
  }
  deleteItem(id) {
    const row = this.get(`SELECT file FROM items WHERE id=?`, id);
    this.run(`DELETE FROM items WHERE id=?`, id);
    return { ok: true, file: row?.file || null };
  }
  setItemFile(id, file) { this.run(`UPDATE items SET file=? WHERE id=?`, file, id); return this.getItem(id); }
  attachItem(itemId, thoughtId) {
    this.mustThought(thoughtId);
    this.run(`INSERT OR IGNORE INTO item_thoughts(item_id,thought_id) VALUES(?,?)`, itemId, thoughtId);
    return this.getItem(itemId);
  }
  detachItem(itemId, thoughtId) {
    this.run(`DELETE FROM item_thoughts WHERE item_id=? AND thought_id=?`, itemId, thoughtId);
    return this.getItem(itemId);
  }

  // ---- actions
  withActionThoughts(actions) {
    const q = this.db.prepare(`SELECT t.id,t.name,t.kind FROM action_thoughts at JOIN thoughts t ON t.id=at.thought_id WHERE at.action_id=? ORDER BY t.name`);
    return actions.map(a => ({ ...a, thoughts: q.all(a.id) }));
  }
  getAction(id) {
    const a = this.get(`SELECT a.*, i.title AS item_title FROM actions a LEFT JOIN items i ON i.id=a.item_id WHERE a.id=?`, id);
    if (!a) throw new HttpError(404, 'Action not found');
    return this.withActionThoughts([a])[0];
  }
  listActions({ status } = {}) {
    const where = status && status !== 'all' ? `WHERE a.status=?` : '';
    const rows = this.all(`SELECT a.*, i.title AS item_title FROM actions a LEFT JOIN items i ON i.id=a.item_id ${where}
                           ORDER BY (a.status='done'), COALESCE(a.due,'9999'), a.id DESC`, ...(where ? [status] : []));
    return this.withActionThoughts(rows);
  }
  createAction(d) {
    const title = String(d.title || '').trim();
    if (!title) throw new HttpError(400, 'Title is required');
    const status = ACTION_STATUS.includes(d.status) ? d.status : 'open';
    return this.tx(() => {
      const r = this.run(`INSERT INTO actions(title,notes,status,due,owner,item_id,created_at,done_at) VALUES(?,?,?,?,?,?,?,?)`,
        title, String(d.notes || ''), status, d.due || null, String(d.owner || ''), d.item_id ? Number(d.item_id) : null,
        now(), status === 'done' ? now() : null);
      const id = Number(r.lastInsertRowid);
      for (const t of d.thoughtIds || []) this.attachAction(id, Number(t));
      return this.getAction(id);
    });
  }
  updateAction(id, d) {
    const cur = this.getAction(id);
    for (const f of ['title', 'notes', 'owner']) if (d[f] !== undefined) this.run(`UPDATE actions SET ${f}=? WHERE id=?`, String(d[f]), id);
    if (d.due !== undefined) this.run(`UPDATE actions SET due=? WHERE id=?`, d.due || null, id);
    if (d.status !== undefined && ACTION_STATUS.includes(d.status) && d.status !== cur.status) {
      this.run(`UPDATE actions SET status=?, done_at=? WHERE id=?`, d.status, d.status === 'done' ? now() : null, id);
    }
    return this.getAction(id);
  }
  deleteAction(id) { this.run(`DELETE FROM actions WHERE id=?`, id); return { ok: true }; }
  attachAction(actionId, thoughtId) {
    this.mustThought(thoughtId);
    this.run(`INSERT OR IGNORE INTO action_thoughts(action_id,thought_id) VALUES(?,?)`, actionId, thoughtId);
    return this.getAction(actionId);
  }
  detachAction(actionId, thoughtId) {
    this.run(`DELETE FROM action_thoughts WHERE action_id=? AND thought_id=?`, actionId, thoughtId);
    return this.getAction(actionId);
  }

  // ---- search & stats
  search(q) {
    q = String(q || '').trim();
    if (!q) return { thoughts: [], items: [], actions: [], weblinks: [] };
    const like = `%${q}%`;
    return {
      thoughts: this.listThoughts(q, 50),
      weblinks: this.all(`SELECT w.*, t.name AS thought_name, t.kind AS thought_kind FROM weblinks w JOIN thoughts t ON t.id=w.thought_id
                          WHERE w.title LIKE ? OR w.url LIKE ? ORDER BY lower(w.title) LIMIT 100`, like, like).map(withKind),
      items: this.withItemThoughts(this.all(
        `SELECT * FROM items WHERE title LIKE ? OR body LIKE ? OR people LIKE ? ORDER BY occurred_at DESC LIMIT 100`, like, like, like)),
      actions: this.withActionThoughts(this.all(
        `SELECT a.*, i.title AS item_title FROM actions a LEFT JOIN items i ON i.id=a.item_id
         WHERE a.title LIKE ? OR a.notes LIKE ? OR a.owner LIKE ? ORDER BY (a.status='done'), COALESCE(a.due,'9999') LIMIT 100`, like, like, like)),
    };
  }
  stats() {
    return {
      home: this.homeId(),
      inbox: this.get(`SELECT COUNT(*) AS n FROM items WHERE status='inbox'`).n,
      open: this.get(`SELECT COUNT(*) AS n FROM actions WHERE status='open'`).n,
      waiting: this.get(`SELECT COUNT(*) AS n FROM actions WHERE status='waiting'`).n,
      overdue: this.get(`SELECT COUNT(*) AS n FROM actions WHERE status<>'done' AND due IS NOT NULL AND due < ?`, today()).n,
      recent: this.all(`SELECT id,name,kind FROM thoughts WHERE visited_at IS NOT NULL ORDER BY visited_at DESC LIMIT 12`),
    };
  }
}

// Accepts http(s) URLs, "www.example.com", and Windows paths (C:\..., \\server\share\...). Anything else is refused.
export function normalizeUrl(raw) {
  let u = String(raw || '').trim().replace(/^["'<]+|[">']+$/g, '');
  if (/^file:\/\//i.test(u)) { try { u = decodeURIComponent(new URL(u).pathname).replace(/^\/([a-z]:)/i, '$1').replace(/\//g, '\\'); } catch {} }
  if (/^[a-z]:\\/i.test(u) || /^\\\\[^\\]+\\/.test(u)) return u;
  if (/^www\./i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new HttpError(400, 'Not a valid link. Use a web address (https://…) or a file path (C:\\…)'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'Only http(s) links and file paths are allowed');
  return parsed.href;
}

export function linkKind(url) {
  if (!/^https?:/i.test(url)) return 'file';
  const host = new URL(url).hostname;
  if (/sharepoint\.com$|onedrive\.live\.com$|^1drv\.ms$/i.test(host)) return 'onedrive';
  if (/teams\.microsoft\.com$|teams\.live\.com$/i.test(host)) return 'teams';
  return 'web';
}
const withKind = l => ({ ...l, kind: linkKind(l.url) });

export function guessTitle(url) {
  if (linkKind(url) === 'file') return url.split('\\').filter(Boolean).pop() || url;
  try {
    const u = new URL(url);
    const file = u.searchParams.get('file');                 // SharePoint Doc.aspx?...&file=Name.docx
    if (file) return file;
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (/\.\w{2,5}$/.test(seg) && !/\.(aspx|html?|php)$/i.test(seg)) return seg;
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? decodeURIComponent(u.pathname).replace(/\/$/, '').slice(0, 60) : '');
  } catch { return url; }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
