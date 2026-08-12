const { Pool, types } = require('pg');
const sqlite3 = require('sqlite3');
const path = require('path');
const config = require('./config');

// node-pg returns BIGINT as a string. We store epoch millis and tweet ids in BIGINT columns;
// both fit in a double, and returning numbers keeps SQLite and PostgreSQL shapes identical.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const isPostgres = !!process.env.DATABASE_URL;

let pgPool;
let sqliteDb;

if (isPostgres) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: config.pgPoolMax,
  });
} else {
  sqliteDb = new sqlite3.Database(path.join(__dirname, 'db.sqlite'));
}

const toPg = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

async function query(sql, params = []) {
  if (isPostgres) return (await pgPool.query(toPg(sql), params)).rows;
  return new Promise((resolve, reject) =>
    sqliteDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))
  );
}

async function run(sql, params = []) {
  if (isPostgres) return { changes: (await pgPool.query(toPg(sql), params)).rowCount };
  return new Promise((resolve, reject) =>
    sqliteDb.run(sql, params, function (err) {
      return err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
    })
  );
}

/**
 * Runs `fn` inside a real transaction.
 *
 * `pool.query('BEGIN')` checks out an arbitrary pooled connection, opens a transaction on it,
 * and returns it to the pool — every later statement lands elsewhere, so the transaction does
 * nothing and the connection is left mid-transaction. It has to be pinned to one client.
 */
async function transaction(fn) {
  if (!isPostgres) {
    await run('BEGIN');
    try {
      const out = await fn({ query, run });
      await run('COMMIT');
      return out;
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  const client = await pgPool.connect();
  const tx = {
    query: (sql, p = []) => client.query(toPg(sql), p).then((r) => r.rows),
    run: (sql, p = []) => client.query(toPg(sql), p).then((r) => ({ changes: r.rowCount })),
  };
  try {
    await client.query('BEGIN');
    const out = await fn(tx);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Multi-VALUES insert. PostgreSQL caps a statement at 65535 bound parameters. */
async function insertBatch(exec, table, columns, rows) {
  if (rows.length === 0) return 0;
  const maxRows = Math.max(1, Math.min(2000, Math.floor(65000 / columns.length)));
  const tuple = `(${columns.map(() => '?').join(',')})`;

  for (let i = 0; i < rows.length; i += maxRows) {
    const chunk = rows.slice(i, i + maxRows);
    await exec.run(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${chunk.map(() => tuple).join(',')} ON CONFLICT DO NOTHING`,
      chunk.flat()
    );
  }
  return rows.length;
}

module.exports = { query, run, transaction, insertBatch, isPostgres };
