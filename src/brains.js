// Registry of brains on this machine (brains.json, not in git) and their open connections.
//
// type 'local' -> SQLite file on this machine + local folder for original files. Never touches the network.
// type 'azure' -> Azure SQL database (shared between laptops); original files stored in the database.
// Every brain has its own watched inbox folder on this machine.
import fs from 'node:fs';
import path from 'node:path';
import { openSqlite, openMssql } from './drivers.js';
import { Brain, HttpError } from './db.js';
import { LocalFiles, SqlFiles } from './files.js';
import { protect, unprotect } from './secret.js';

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'brain';

export class BrainManager {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'brains.json');
    this.open = new Map();      // id -> Promise<{ cfg, brain, files }>
    this.onChange = () => {};
    if (fs.existsSync(this.file)) {
      this.reg = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      // First run: the existing database becomes the local "Work brain".
      this.reg = { brains: [{
        id: 'work', name: 'Work brain', type: 'local',
        db: process.env.BRAIN_DB || 'data/brain.db',
        inbox: process.env.BRAIN_WATCH || 'inbox',
      }] };
      this.save();
    }
  }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.reg, null, 2) + '\n'); }
  abs(p) { return path.resolve(this.root, p); }
  cfg(id) {
    const c = this.reg.brains.find(b => b.id === id);
    if (!c) throw new HttpError(404, `Unknown brain "${id}"`);
    return c;
  }
  inboxDir(c) { return this.abs(c.inbox); }

  // Public view (no secrets)
  list() {
    return this.reg.brains.map(c => ({
      id: c.id, name: c.name, type: c.type, inbox: this.inboxDir(c),
      ...(c.type === 'local' ? { db: this.abs(c.db) } : { server: c.server, database: c.database, auth: c.auth, user: c.user || '', tenantId: c.tenantId || '' }),
    }));
  }

  get(id) {
    const c = this.cfg(id);
    if (!this.open.has(id)) {
      const p = this.#connect(c);
      this.open.set(id, p);
      p.catch(() => this.open.delete(id));   // allow a retry after a failed connection
    }
    return this.open.get(id);
  }

  async #connect(c) {
    if (c.type === 'local') {
      const dbFile = this.abs(c.db);
      const brain = await new Brain(openSqlite(dbFile)).init();
      return { cfg: c, brain, files: new LocalFiles(path.join(path.dirname(dbFile), 'files')) };
    }
    if (c.type === 'azure') {
      const password = c.auth === 'sql' ? await unprotect(c.passwordProtected || '') : null;
      const driver = await openMssql(c, password);
      const brain = await new Brain(driver).init();
      return { cfg: c, brain, files: new SqlFiles(driver) };
    }
    throw new HttpError(500, `Unknown brain type "${c.type}"`);
  }

  async create(input) {
    const name = String(input.name || '').trim();
    if (!name) throw new HttpError(400, 'Name is required');
    if (this.reg.brains.some(b => b.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A brain named "${name}" already exists`);
    let id = slug(name);
    for (let i = 2; this.reg.brains.some(b => b.id === id); i++) id = `${slug(name)}-${i}`;
    const inbox = String(input.inbox || '').trim() || `inbox-${id}`;
    let c;
    if (input.type === 'local') {
      c = { id, name, type: 'local', db: `data/brains/${id}/brain.db`, inbox };
    } else if (input.type === 'azure') {
      const server = String(input.server || '').trim().replace(/^tcp:/i, '').replace(/,1433$/, '');
      const database = String(input.database || '').trim();
      if (!server || !database) throw new HttpError(400, 'Server and database are required for an Azure brain');
      const auth = input.auth === 'sql' ? 'sql' : 'entra';
      c = { id, name, type: 'azure', server, database, auth, inbox };
      if (auth === 'entra' && input.tenantId) c.tenantId = String(input.tenantId).trim();
      if (auth === 'sql') {
        if (!input.user || !input.password) throw new HttpError(400, 'User and password are required for SQL authentication');
        c.user = String(input.user).trim();
        c.passwordProtected = await protect(String(input.password));
      }
    } else {
      throw new HttpError(400, 'type must be "local" or "azure"');
    }
    // Connect (and create the tables) before saving, so a wrong server/password is reported right away.
    this.reg.brains.push(c);
    try { await this.get(id); }
    catch (e) {
      this.reg.brains = this.reg.brains.filter(b => b.id !== id);
      throw new HttpError(400, e.message);
    }
    this.save();
    this.onChange();
    return this.list().find(b => b.id === id);
  }

  async update(id, input) {
    const c = this.cfg(id);
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new HttpError(400, 'Name is required');
      if (this.reg.brains.some(b => b.id !== id && b.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A brain named "${name}" already exists`);
      c.name = name;
    }
    if (input.inbox !== undefined && String(input.inbox).trim()) c.inbox = String(input.inbox).trim();
    if (c.type === 'azure' && c.auth === 'sql' && input.password) {
      c.passwordProtected = await protect(String(input.password));
      await this.close(id);
    }
    this.save();
    this.onChange();
    return this.list().find(b => b.id === id);
  }

  // Only removes the brain from this machine's list. The data itself (SQLite file / Azure database) is kept.
  async remove(id) {
    this.cfg(id);
    if (this.reg.brains.length === 1) throw new HttpError(400, 'You cannot remove the last brain');
    await this.close(id);
    this.reg.brains = this.reg.brains.filter(b => b.id !== id);
    this.save();
    this.onChange();
    return { ok: true };
  }

  async close(id) {
    const p = this.open.get(id);
    this.open.delete(id);
    if (p) { try { (await p).brain.close(); } catch {} }
  }
}
