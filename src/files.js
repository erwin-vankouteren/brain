// Where the original imported files (PDF, images, mails, ...) are kept.
//  - LocalFiles: a folder next to the SQLite database (local brains; never leaves the machine)
//  - SqlFiles:   the "files" table in the Azure SQL database (cloud brains; available on every laptop)
import fs from 'node:fs';
import path from 'node:path';

const safeName = name => path.basename(name).replace(/[^\p{L}\p{N}_.\- ()]+/gu, '_').slice(-120) || 'file';

export class LocalFiles {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  // Moves the temp file into place; returns the name to store on the item.
  async save(itemId, originalName, tmpPath) {
    const stored = `${itemId}-${safeName(originalName)}`;
    const target = path.join(this.dir, stored);
    try { fs.renameSync(tmpPath, target); }
    catch { fs.copyFileSync(tmpPath, target); fs.rmSync(tmpPath, { force: true }); }   // temp folder on another drive
    return stored;
  }
  async read(item) {
    const full = item.file && path.join(this.dir, path.basename(item.file));
    if (!full || !fs.existsSync(full)) return null;
    return { name: item.file.replace(/^\d+-/, ''), data: fs.readFileSync(full) };
  }
  async remove(file) { if (file) fs.rmSync(path.join(this.dir, path.basename(file)), { force: true }); }
}

export class SqlFiles {
  constructor(driver) { this.d = driver; }
  async save(itemId, originalName, tmpPath) {
    const name = safeName(originalName);
    await this.d.run(`DELETE FROM files WHERE item_id=?`, itemId);
    await this.d.run(`INSERT INTO files(item_id,name,content) VALUES(?,?,?)`, itemId, name, fs.readFileSync(tmpPath));
    fs.rmSync(tmpPath, { force: true });
    return name;
  }
  async read(item) {
    const r = await this.d.get(`SELECT name, content FROM files WHERE item_id=?`, item.id);
    return r ? { name: r.name, data: Buffer.from(r.content) } : null;
  }
  async remove() { /* the row is deleted together with the item */ }
}
