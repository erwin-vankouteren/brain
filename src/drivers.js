// Two storage drivers with the same small async interface, so the Brain logic is written once:
//   all(sql, ...params) -> rows      get(sql, ...params) -> row | undefined
//   run(sql, ...params) -> {changes} insert(sql, ...params) -> new id
//   exec(sql)  transaction(fn(driver))  close()  limit(n) -> dialect-specific "first n rows" clause
// SQL is written with ? placeholders in a subset that both SQLite and T-SQL understand.
//
// COMPLIANCE: a *local* brain only ever uses openSqlite(); nothing in a local brain goes to the network.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- SQLite (local brains)
export function openSqlite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  let inTx = false;
  const d = {
    dialect: 'sqlite',
    limit: n => `LIMIT ${n | 0}`,
    async exec(sql) { db.exec(sql); },
    async all(sql, ...p) { return db.prepare(sql).all(...p); },
    async get(sql, ...p) { return db.prepare(sql).get(...p); },
    async run(sql, ...p) { return { changes: Number(db.prepare(sql).run(...p).changes) }; },
    async insert(sql, ...p) { return Number(db.prepare(sql).run(...p).lastInsertRowid); },
    // Safe because every statement is synchronous: no other request can run between BEGIN and COMMIT.
    async transaction(fn) {
      if (inTx) return fn(d);
      db.exec('BEGIN'); inTx = true;
      try { const r = await fn(d); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      finally { inTx = false; }
    },
    async close() { db.close(); },
  };
  return d;
}

// ---------------------------------------------------------------- Azure SQL (cloud brains)
// cfg: { server, database, auth: 'entra' | 'sql', tenantId?, user? }, password only for auth 'sql'.
// sqlModule can be injected (tests use mssql/msnodesqlv8 against LocalDB).
const TRANSIENT = new Set([40613, 40197, 40501, 49918, 49919, 49920, 4060, 4221, 10928, 10929]);
const isTransient = e => !/getaddrinfo|ENOTFOUND/i.test(e?.message || '') &&      // unknown server name: don't retry
  (TRANSIENT.has(e?.number ?? e?.originalError?.info?.number) || ['ESOCKET', 'ETIMEOUT', 'ECONNRESET', 'ECONNCLOSED'].includes(e?.code));
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function openMssql(cfg, password, { sqlModule, config: overrideConfig } = {}) {
  const sql = sqlModule || (await import('mssql')).default;
  let config = overrideConfig;
  if (!config) {
    config = {
      server: cfg.server, database: cfg.database,
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 60000,   // a paused serverless database can take up to a minute to resume
      requestTimeout: 60000,
      pool: { max: 5, min: 0, idleTimeoutMillis: 300000 },
    };
    if (cfg.auth === 'sql') { config.user = cfg.user; config.password = password; }
    else {
      const { DefaultAzureCredential } = await import('@azure/identity');
      config.authentication = { type: 'token-credential', options: { credential: new DefaultAzureCredential(cfg.tenantId ? { tenantId: cfg.tenantId } : {}) } };
    }
  }

  let pool;
  for (let attempt = 1; ; attempt++) {
    try { pool = await new sql.ConnectionPool(config).connect(); break; }
    catch (e) {
      if (attempt >= 4 || !isTransient(e)) throw new Error(`Cannot connect to Azure SQL: ${e.message}`);
      await sleep(attempt * 5000);
    }
  }

  const bind = (text, params, req) => {
    let i = 0;
    const out = text.replace(/\?/g, () => `@v${i++}`);   // not @p…: some drivers use those names internally
    params.forEach((v, j) => req.input(`v${j}`, v === undefined ? null : v));
    return out;
  };
  const make = (newRequest, inTx) => {
    const q = async (text, params, suffix = '') => {
      for (let attempt = 1; ; attempt++) {
        try { const r = newRequest(); return await r.query(bind(text, params, r) + suffix); }
        catch (e) {
          if (inTx || attempt >= 3 || !isTransient(e)) throw e;
          await sleep(attempt * 3000);
        }
      }
    };
    const d = {
      dialect: 'mssql',
      limit: n => `OFFSET 0 ROWS FETCH NEXT ${n | 0} ROWS ONLY`,
      async exec(text) { await newRequest().batch(text); },
      async all(text, ...p) { return (await q(text, p)).recordset || []; },
      async get(text, ...p) { return (await q(text, p)).recordset?.[0]; },
      async run(text, ...p) { return { changes: (await q(text, p)).rowsAffected.reduce((a, b) => a + b, 0) }; },
      async insert(text, ...p) { const r = await q(text, p, '; SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;'); return r.recordsets.at(-1)[0].id; },
      async transaction(fn) {
        if (inTx) return fn(d);
        const tx = new sql.Transaction(pool);
        await tx.begin();
        try { const r = await fn(make(() => new sql.Request(tx), true)); await tx.commit(); return r; }
        catch (e) { try { await tx.rollback(); } catch {} throw e; }
      },
      async close() { await pool.close(); },
    };
    return d;
  };
  return make(() => new sql.Request(pool), false);
}
