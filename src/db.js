// Data layer for one brain: thoughts (topics/people/projects), typed links between them,
// captured items (snippets from mail/Teams/notes/...), actions (to-dos) and links to documents.
// Works on a driver from drivers.js (SQLite for local brains, Azure SQL for cloud brains).
// Queries use the SQL subset both understand: ? placeholders, [key]/[file] quoting, CASE instead of
// boolean expressions, d.limit(n) instead of LIMIT, and no reliance on ON DELETE CASCADE.

export const KINDS = ['topic', 'project', 'person', 'org'];
export const SOURCES = ['note', 'meeting', 'teams', 'email', 'whatsapp', 'onenote', 'notepad', 'paper', 'document', 'other'];
export const ACTION_STATUS = ['open', 'waiting', 'done'];

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toLocaleDateString('sv-SE');

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta ([key] TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS thoughts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'topic', notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, visited_at TEXT);
  -- type 'child': a is parent of b. type 'jump': a < b, undirected.
  CREATE TABLE IF NOT EXISTS links (
    a INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    b INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('child','jump')), PRIMARY KEY (a, b));
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'note',
    occurred_at TEXT NOT NULL, people TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','filed')), created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS item_thoughts (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    thought_id INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE, PRIMARY KEY (item_id, thought_id));
  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','done')), due TEXT, owner TEXT NOT NULL DEFAULT '',
    item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, created_at TEXT NOT NULL, done_at TEXT);
  CREATE TABLE IF NOT EXISTS action_thoughts (
    action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    thought_id INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE, PRIMARY KEY (action_id, thought_id));
  CREATE TABLE IF NOT EXISTS weblinks (
    id INTEGER PRIMARY KEY, thought_id INTEGER NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ix_weblinks_t ON weblinks(thought_id);
  CREATE INDEX IF NOT EXISTS ix_links_b ON links(b);
  CREATE INDEX IF NOT EXISTS ix_item_thoughts_t ON item_thoughts(thought_id);
  CREATE INDEX IF NOT EXISTS ix_action_thoughts_t ON action_thoughts(thought_id);`;

// Azure SQL: same tables. Foreign keys without cascades (SQL Server refuses multiple cascade paths);
// the code below deletes dependent rows itself. Original files live in the "files" table.
const MSSQL_SCHEMA = `
IF OBJECT_ID('dbo.meta') IS NULL CREATE TABLE dbo.meta ([key] NVARCHAR(50) NOT NULL PRIMARY KEY, value NVARCHAR(400) NULL);
IF OBJECT_ID('dbo.thoughts') IS NULL CREATE TABLE dbo.thoughts (
  id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(400) NOT NULL, kind NVARCHAR(20) NOT NULL DEFAULT 'topic',
  notes NVARCHAR(MAX) NOT NULL DEFAULT '', created_at NVARCHAR(20) NOT NULL, updated_at NVARCHAR(20) NOT NULL, visited_at NVARCHAR(20) NULL);
IF OBJECT_ID('dbo.links') IS NULL CREATE TABLE dbo.links (
  a INT NOT NULL REFERENCES dbo.thoughts(id), b INT NOT NULL REFERENCES dbo.thoughts(id),
  type NVARCHAR(10) NOT NULL CHECK (type IN ('child','jump')), PRIMARY KEY (a, b));
IF OBJECT_ID('dbo.items') IS NULL CREATE TABLE dbo.items (
  id INT IDENTITY(1,1) PRIMARY KEY, title NVARCHAR(1000) NOT NULL DEFAULT '', body NVARCHAR(MAX) NOT NULL DEFAULT '',
  source NVARCHAR(20) NOT NULL DEFAULT 'note', occurred_at NVARCHAR(20) NOT NULL, people NVARCHAR(2000) NOT NULL DEFAULT '',
  origin NVARCHAR(400) NOT NULL DEFAULT '', status NVARCHAR(10) NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','filed')),
  created_at NVARCHAR(20) NOT NULL, [file] NVARCHAR(400) NULL);
IF OBJECT_ID('dbo.item_thoughts') IS NULL CREATE TABLE dbo.item_thoughts (
  item_id INT NOT NULL REFERENCES dbo.items(id), thought_id INT NOT NULL REFERENCES dbo.thoughts(id), PRIMARY KEY (item_id, thought_id));
IF OBJECT_ID('dbo.actions') IS NULL CREATE TABLE dbo.actions (
  id INT IDENTITY(1,1) PRIMARY KEY, title NVARCHAR(1000) NOT NULL, notes NVARCHAR(MAX) NOT NULL DEFAULT '',
  status NVARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','done')), due NVARCHAR(10) NULL,
  owner NVARCHAR(200) NOT NULL DEFAULT '', item_id INT NULL REFERENCES dbo.items(id), created_at NVARCHAR(20) NOT NULL, done_at NVARCHAR(20) NULL);
IF OBJECT_ID('dbo.action_thoughts') IS NULL CREATE TABLE dbo.action_thoughts (
  action_id INT NOT NULL REFERENCES dbo.actions(id), thought_id INT NOT NULL REFERENCES dbo.thoughts(id), PRIMARY KEY (action_id, thought_id));
IF OBJECT_ID('dbo.weblinks') IS NULL CREATE TABLE dbo.weblinks (
  id INT IDENTITY(1,1) PRIMARY KEY, thought_id INT NOT NULL REFERENCES dbo.thoughts(id),
  url NVARCHAR(2000) NOT NULL, title NVARCHAR(1000) NOT NULL DEFAULT '', created_at NVARCHAR(20) NOT NULL);
IF OBJECT_ID('dbo.files') IS NULL CREATE TABLE dbo.files (
  item_id INT NOT NULL PRIMARY KEY REFERENCES dbo.items(id), name NVARCHAR(400) NOT NULL, content VARBINARY(MAX) NOT NULL);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='ix_links_b') CREATE INDEX ix_links_b ON dbo.links(b);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='ix_item_thoughts_t') CREATE INDEX ix_item_thoughts_t ON dbo.item_thoughts(thought_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='ix_action_thoughts_t') CREATE INDEX ix_action_thoughts_t ON dbo.action_thoughts(thought_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='ix_weblinks_t') CREATE INDEX ix_weblinks_t ON dbo.weblinks(thought_id);`;

const T = `t.id, t.name, t.kind`;
const chunks = (arr, n = 500) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const marks = n => Array(n).fill('?').join(',');

export class Brain {
  constructor(driver) { this.d = driver; }

  async init() {
    if (this.d.dialect === 'sqlite') {
      await this.d.exec(SQLITE_SCHEMA);
      const cols = await this.d.all(`PRAGMA table_info(items)`);
      if (!cols.some(c => c.name === 'file')) await this.d.exec(`ALTER TABLE items ADD COLUMN [file] TEXT`);
    } else {
      await this.d.exec(MSSQL_SCHEMA);
    }
    if (!(await this.homeId())) {
      const id = (await this.createThought('My Brain', 'topic')).id;
      await this.setMeta('home', String(id));
    }
    return this;
  }
  close() { return this.d.close(); }

  // Run fn with a Brain bound to a transaction (nested calls reuse it).
  tx(fn) { return this.d.transaction(d => { const b = Object.create(this); b.d = d; return fn(b); }); }

  async setMeta(key, value) {
    await this.tx(async b => {
      await b.d.run(`DELETE FROM meta WHERE [key]=?`, key);
      await b.d.run(`INSERT INTO meta([key],value) VALUES(?,?)`, key, value);
    });
  }
  async homeId() { const r = await this.d.get(`SELECT value FROM meta WHERE [key]='home'`); return r ? Number(r.value) : null; }
  async setHome(id) { await this.mustThought(id); await this.setMeta('home', String(id)); }
  async mustThought(id) {
    const t = await this.d.get(`SELECT id,name,kind,notes,created_at,updated_at FROM thoughts WHERE id=?`, id);
    if (!t) throw new HttpError(404, 'Thought not found');
    return t;
  }

  // ---- thoughts
  listThoughts(q = '', limit = 20) {
    q = String(q).trim();
    if (!q) return this.d.all(`SELECT id,name,kind FROM thoughts ORDER BY COALESCE(visited_at, updated_at) DESC, id DESC ${this.d.limit(limit)}`);
    return this.d.all(
      `SELECT id,name,kind FROM thoughts WHERE name LIKE ?
       ORDER BY CASE WHEN lower(name)=lower(?) THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, name ${this.d.limit(limit)}`,
      `%${q}%`, q, `${q}%`);
  }

  async createThought(name, kind = 'topic') {
    name = String(name || '').trim();
    if (!name) throw new HttpError(400, 'Name is required');
    if (!KINDS.includes(kind)) kind = 'topic';
    const existing = await this.d.get(`SELECT id,name,kind FROM thoughts WHERE lower(name)=lower(?)`, name);
    if (existing) return existing;
    const id = await this.d.insert(`INSERT INTO thoughts(name,kind,notes,created_at,updated_at) VALUES(?,?,'',?,?)`, name, kind, now(), now());
    return { id, name, kind };
  }

  async getThought(id) {
    const t = await this.mustThought(id);
    const d = this.d;
    await d.run(`UPDATE thoughts SET visited_at=? WHERE id=?`, now(), id);
    const [parents, children, jumps, siblings, itemRows, actionRows, weblinks, home] = await Promise.all([
      d.all(`SELECT ${T} FROM links l JOIN thoughts t ON t.id=l.a WHERE l.b=? AND l.type='child' ORDER BY t.name`, id),
      d.all(`SELECT ${T} FROM links l JOIN thoughts t ON t.id=l.b WHERE l.a=? AND l.type='child' ORDER BY t.name`, id),
      d.all(`SELECT ${T} FROM links l JOIN thoughts t ON t.id = CASE WHEN l.a=? THEN l.b ELSE l.a END
             WHERE l.type='jump' AND (l.a=? OR l.b=?) ORDER BY t.name`, id, id, id),
      d.all(`SELECT DISTINCT ${T} FROM links p JOIN links s ON s.a=p.a AND s.type='child' JOIN thoughts t ON t.id=s.b
             WHERE p.b=? AND p.type='child' AND s.b<>? ORDER BY t.name ${d.limit(40)}`, id, id),
      d.all(`SELECT i.id,i.title,i.body,i.source,i.occurred_at,i.people,i.origin,i.status,i.created_at,i.[file]
             FROM items i JOIN item_thoughts it ON it.item_id=i.id WHERE it.thought_id=? ORDER BY i.occurred_at DESC, i.id DESC`, id),
      d.all(`SELECT a.*, i.title AS item_title FROM actions a JOIN action_thoughts ac ON ac.action_id=a.id
             LEFT JOIN items i ON i.id=a.item_id WHERE ac.thought_id=?
             ORDER BY CASE WHEN a.status='done' THEN 1 ELSE 0 END, COALESCE(a.due,'9999'), a.id`, id),
      d.all(`SELECT * FROM weblinks WHERE thought_id=? ORDER BY lower(title), id`, id),
      this.homeId(),
    ]);
    const [items, actions] = await Promise.all([this.withItemThoughts(itemRows), this.withActionThoughts(actionRows)]);
    return { ...t, isHome: id === home, parents, children, jumps, siblings, items, actions, weblinks: weblinks.map(withKind) };
  }

  async updateThought(id, { name, kind, notes }) {
    await this.mustThought(id);
    if (name !== undefined) {
      name = String(name).trim();
      if (!name) throw new HttpError(400, 'Name is required');
      const clash = await this.d.get(`SELECT id FROM thoughts WHERE lower(name)=lower(?) AND id<>?`, name, id);
      if (clash) throw new HttpError(409, `A thought named "${name}" already exists`);
      await this.d.run(`UPDATE thoughts SET name=? WHERE id=?`, name, id);
    }
    if (kind !== undefined && KINDS.includes(kind)) await this.d.run(`UPDATE thoughts SET kind=? WHERE id=?`, kind, id);
    if (notes !== undefined) await this.d.run(`UPDATE thoughts SET notes=? WHERE id=?`, String(notes), id);
    await this.d.run(`UPDATE thoughts SET updated_at=? WHERE id=?`, now(), id);
    return this.mustThought(id);
  }

  async deleteThought(id) {
    if (id === await this.homeId()) throw new HttpError(400, 'The home thought cannot be deleted');
    await this.mustThought(id);
    await this.tx(async b => {
      await b.d.run(`DELETE FROM links WHERE a=? OR b=?`, id, id);
      await b.d.run(`DELETE FROM item_thoughts WHERE thought_id=?`, id);
      await b.d.run(`DELETE FROM action_thoughts WHERE thought_id=?`, id);
      await b.d.run(`DELETE FROM weblinks WHERE thought_id=?`, id);
      await b.d.run(`DELETE FROM thoughts WHERE id=?`, id);
    });
    return { ok: true };
  }

  // rel describes `to` relative to `from`: 'parent' | 'child' | 'jump'
  async link(from, to, rel) {
    if (from === to) throw new HttpError(400, 'Cannot link a thought to itself');
    if (!['parent', 'child', 'jump'].includes(rel)) throw new HttpError(400, 'rel must be parent, child or jump');
    await this.mustThought(from); await this.mustThought(to);
    await this.tx(async b => {
      await b.unlink(from, to);
      if (rel === 'child') await b.d.run(`INSERT INTO links(a,b,type) VALUES(?,?,'child')`, from, to);
      else if (rel === 'parent') await b.d.run(`INSERT INTO links(a,b,type) VALUES(?,?,'child')`, to, from);
      else await b.d.run(`INSERT INTO links(a,b,type) VALUES(?,?,'jump')`, Math.min(from, to), Math.max(from, to));
    });
    return { ok: true };
  }
  async unlink(a, b) {
    await this.d.run(`DELETE FROM links WHERE (a=? AND b=?) OR (a=? AND b=?)`, a, b, b, a);
    return { ok: true };
  }

  // ---- items
  async withItemThoughts(items) {
    if (!items.length) return [];
    const ids = items.map(i => i.id), tmap = new Map(), amap = new Map();
    for (const c of chunks(ids)) {
      for (const r of await this.d.all(`SELECT it.item_id, t.id, t.name, t.kind FROM item_thoughts it JOIN thoughts t ON t.id=it.thought_id
                                        WHERE it.item_id IN (${marks(c.length)}) ORDER BY t.name`, ...c)) {
        if (!tmap.has(r.item_id)) tmap.set(r.item_id, []);
        tmap.get(r.item_id).push({ id: r.id, name: r.name, kind: r.kind });
      }
      for (const r of await this.d.all(`SELECT item_id, COUNT(*) AS n FROM actions WHERE status<>'done' AND item_id IN (${marks(c.length)}) GROUP BY item_id`, ...c))
        amap.set(r.item_id, r.n);
    }
    return items.map(i => ({ ...i, thoughts: tmap.get(i.id) || [], openActions: amap.get(i.id) || 0 }));
  }
  async getItem(id) {
    const i = await this.d.get(`SELECT * FROM items WHERE id=?`, id);
    if (!i) throw new HttpError(404, 'Item not found');
    return (await this.withItemThoughts([i]))[0];
  }
  async listItems({ status } = {}) {
    const rows = status
      ? await this.d.all(`SELECT * FROM items WHERE status=? ORDER BY occurred_at DESC, id DESC`, status)
      : await this.d.all(`SELECT * FROM items ORDER BY occurred_at DESC, id DESC ${this.d.limit(500)}`);
    return this.withItemThoughts(rows);
  }
  async createItem(data) {
    const source = SOURCES.includes(data.source) ? data.source : 'other';
    let title = String(data.title || '').trim();
    const body = String(data.body || '');
    if (!title) title = (body.split('\n').find(l => l.trim()) || 'Untitled').trim().slice(0, 120);
    const thoughtIds = (data.thoughtIds || []).map(Number);
    const status = data.status === 'filed' || data.status === 'inbox' ? data.status : (thoughtIds.length ? 'filed' : 'inbox');
    const id = await this.tx(async b => {
      const id = await b.d.insert(`INSERT INTO items(title,body,source,occurred_at,people,origin,status,created_at) VALUES(?,?,?,?,?,?,?,?)`,
        title.slice(0, 1000), body, source, data.occurred_at || today(), String(data.people || '').slice(0, 2000), String(data.origin || '').slice(0, 400), status, now());
      for (const t of thoughtIds) await b.attachItem(id, t, false);
      return id;
    });
    return this.getItem(id);
  }
  async updateItem(id, data) {
    await this.getItem(id);
    await this.tx(async b => {
      for (const f of ['title', 'body', 'source', 'occurred_at', 'people', 'status']) {
        if (data[f] === undefined) continue;
        if (f === 'source' && !SOURCES.includes(data[f])) continue;
        if (f === 'status' && !['inbox', 'filed'].includes(data[f])) continue;
        await b.d.run(`UPDATE items SET ${f}=? WHERE id=?`, String(data[f]), id);
      }
      if (Array.isArray(data.thoughtIds)) {
        await b.d.run(`DELETE FROM item_thoughts WHERE item_id=?`, id);
        for (const t of data.thoughtIds) await b.attachItem(id, Number(t), false);
      }
    });
    return this.getItem(id);
  }
  // Returns the stored file name (if any) so the caller can remove the original file too.
  async deleteItem(id) {
    const row = await this.d.get(`SELECT [file] FROM items WHERE id=?`, id);
    await this.tx(async b => {
      await b.d.run(`DELETE FROM item_thoughts WHERE item_id=?`, id);
      await b.d.run(`UPDATE actions SET item_id=NULL WHERE item_id=?`, id);
      if (b.d.dialect === 'mssql') await b.d.run(`DELETE FROM files WHERE item_id=?`, id);
      await b.d.run(`DELETE FROM items WHERE id=?`, id);
    });
    return { ok: true, file: row?.file || null };
  }
  async setItemFile(id, file) { await this.d.run(`UPDATE items SET [file]=? WHERE id=?`, file, id); return this.getItem(id); }
  async attachItem(itemId, thoughtId, returnItem = true) {
    await this.mustThought(thoughtId);
    await this.d.run(`INSERT INTO item_thoughts(item_id,thought_id) SELECT ?,? WHERE NOT EXISTS
                      (SELECT 1 FROM item_thoughts WHERE item_id=? AND thought_id=?)`, itemId, thoughtId, itemId, thoughtId);
    return returnItem ? this.getItem(itemId) : null;
  }
  async detachItem(itemId, thoughtId) {
    await this.d.run(`DELETE FROM item_thoughts WHERE item_id=? AND thought_id=?`, itemId, thoughtId);
    return this.getItem(itemId);
  }

  // ---- actions
  async withActionThoughts(actions) {
    if (!actions.length) return [];
    const tmap = new Map();
    for (const c of chunks(actions.map(a => a.id))) {
      for (const r of await this.d.all(`SELECT ac.action_id, t.id, t.name, t.kind FROM action_thoughts ac JOIN thoughts t ON t.id=ac.thought_id
                                        WHERE ac.action_id IN (${marks(c.length)}) ORDER BY t.name`, ...c)) {
        if (!tmap.has(r.action_id)) tmap.set(r.action_id, []);
        tmap.get(r.action_id).push({ id: r.id, name: r.name, kind: r.kind });
      }
    }
    return actions.map(a => ({ ...a, thoughts: tmap.get(a.id) || [] }));
  }
  async getAction(id) {
    const a = await this.d.get(`SELECT a.*, i.title AS item_title FROM actions a LEFT JOIN items i ON i.id=a.item_id WHERE a.id=?`, id);
    if (!a) throw new HttpError(404, 'Action not found');
    return (await this.withActionThoughts([a]))[0];
  }
  async listActions({ status } = {}) {
    const filter = status && status !== 'all';
    const rows = await this.d.all(`SELECT a.*, i.title AS item_title FROM actions a LEFT JOIN items i ON i.id=a.item_id ${filter ? 'WHERE a.status=?' : ''}
                                   ORDER BY CASE WHEN a.status='done' THEN 1 ELSE 0 END, COALESCE(a.due,'9999'), a.id DESC`, ...(filter ? [status] : []));
    return this.withActionThoughts(rows);
  }
  async createAction(data) {
    const title = String(data.title || '').trim();
    if (!title) throw new HttpError(400, 'Title is required');
    const status = ACTION_STATUS.includes(data.status) ? data.status : 'open';
    const id = await this.tx(async b => {
      const id = await b.d.insert(`INSERT INTO actions(title,notes,status,due,owner,item_id,created_at,done_at) VALUES(?,?,?,?,?,?,?,?)`,
        title.slice(0, 1000), String(data.notes || ''), status, data.due || null, String(data.owner || '').slice(0, 200),
        data.item_id ? Number(data.item_id) : null, now(), status === 'done' ? now() : null);
      for (const t of data.thoughtIds || []) await b.attachAction(id, Number(t), false);
      return id;
    });
    return this.getAction(id);
  }
  async updateAction(id, data) {
    const cur = await this.getAction(id);
    for (const f of ['title', 'notes', 'owner']) if (data[f] !== undefined) await this.d.run(`UPDATE actions SET ${f}=? WHERE id=?`, String(data[f]), id);
    if (data.due !== undefined) await this.d.run(`UPDATE actions SET due=? WHERE id=?`, data.due || null, id);
    if (data.status !== undefined && ACTION_STATUS.includes(data.status) && data.status !== cur.status)
      await this.d.run(`UPDATE actions SET status=?, done_at=? WHERE id=?`, data.status, data.status === 'done' ? now() : null, id);
    return this.getAction(id);
  }
  async deleteAction(id) {
    await this.tx(async b => {
      await b.d.run(`DELETE FROM action_thoughts WHERE action_id=?`, id);
      await b.d.run(`DELETE FROM actions WHERE id=?`, id);
    });
    return { ok: true };
  }
  async attachAction(actionId, thoughtId, returnAction = true) {
    await this.mustThought(thoughtId);
    await this.d.run(`INSERT INTO action_thoughts(action_id,thought_id) SELECT ?,? WHERE NOT EXISTS
                      (SELECT 1 FROM action_thoughts WHERE action_id=? AND thought_id=?)`, actionId, thoughtId, actionId, thoughtId);
    return returnAction ? this.getAction(actionId) : null;
  }
  async detachAction(actionId, thoughtId) {
    await this.d.run(`DELETE FROM action_thoughts WHERE action_id=? AND thought_id=?`, actionId, thoughtId);
    return this.getAction(actionId);
  }

  // ---- links to documents / web pages
  async getWeblink(id) {
    const l = await this.d.get(`SELECT * FROM weblinks WHERE id=?`, id);
    if (!l) throw new HttpError(404, 'Link not found');
    return withKind(l);
  }
  async addWeblink(thoughtId, { url, title }) {
    await this.mustThought(thoughtId);
    url = normalizeUrl(url);
    title = String(title || '').trim() || guessTitle(url);
    const id = await this.d.insert(`INSERT INTO weblinks(thought_id,url,title,created_at) VALUES(?,?,?,?)`, thoughtId, url.slice(0, 2000), title.slice(0, 1000), now());
    return this.getWeblink(id);
  }
  async updateWeblink(id, { url, title }) {
    const cur = await this.getWeblink(id);
    if (url !== undefined) await this.d.run(`UPDATE weblinks SET url=? WHERE id=?`, normalizeUrl(url), id);
    if (title !== undefined) await this.d.run(`UPDATE weblinks SET title=? WHERE id=?`, String(title).trim() || guessTitle(url ? normalizeUrl(url) : cur.url), id);
    return this.getWeblink(id);
  }
  async deleteWeblink(id) { await this.d.run(`DELETE FROM weblinks WHERE id=?`, id); return { ok: true }; }

  // ---- search & stats
  async search(q) {
    q = String(q || '').trim();
    if (!q) return { thoughts: [], items: [], actions: [], weblinks: [] };
    const like = `%${q}%`, d = this.d;
    const [thoughts, weblinks, itemRows, actionRows] = await Promise.all([
      this.listThoughts(q, 50),
      d.all(`SELECT w.*, t.name AS thought_name, t.kind AS thought_kind FROM weblinks w JOIN thoughts t ON t.id=w.thought_id
             WHERE w.title LIKE ? OR w.url LIKE ? ORDER BY lower(w.title) ${d.limit(100)}`, like, like),
      d.all(`SELECT * FROM items WHERE title LIKE ? OR body LIKE ? OR people LIKE ? ORDER BY occurred_at DESC, id DESC ${d.limit(100)}`, like, like, like),
      d.all(`SELECT a.*, i.title AS item_title FROM actions a LEFT JOIN items i ON i.id=a.item_id
             WHERE a.title LIKE ? OR a.notes LIKE ? OR a.owner LIKE ?
             ORDER BY CASE WHEN a.status='done' THEN 1 ELSE 0 END, COALESCE(a.due,'9999'), a.id ${d.limit(100)}`, like, like, like),
    ]);
    const [items, actions] = await Promise.all([this.withItemThoughts(itemRows), this.withActionThoughts(actionRows)]);
    return { thoughts, weblinks: weblinks.map(withKind), items, actions };
  }
  async stats() {
    const d = this.d, n = r => r?.n ?? 0;
    const [home, inbox, open, waiting, overdue, recent] = await Promise.all([
      this.homeId(),
      d.get(`SELECT COUNT(*) AS n FROM items WHERE status='inbox'`),
      d.get(`SELECT COUNT(*) AS n FROM actions WHERE status='open'`),
      d.get(`SELECT COUNT(*) AS n FROM actions WHERE status='waiting'`),
      d.get(`SELECT COUNT(*) AS n FROM actions WHERE status<>'done' AND due IS NOT NULL AND due < ?`, today()),
      d.all(`SELECT id,name,kind FROM thoughts WHERE visited_at IS NOT NULL ORDER BY visited_at DESC ${d.limit(12)}`),
    ]);
    return { home, inbox: n(inbox), open: n(open), waiting: n(waiting), overdue: n(overdue), recent };
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
