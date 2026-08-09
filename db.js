const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let pgPool;
let sqliteDb;

const isPostgres = !!process.env.DATABASE_URL;

if (isPostgres) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Render secure connection
  });
} else {
  const dbPath = path.join(__dirname, 'db.sqlite');
  sqliteDb = new sqlite3.Database(dbPath);
}

/**
 * Executes a SELECT query and returns the rows.
 * Converts standard "?" placeholders to PostgreSQL "$1, $2" placeholders on the fly.
 */
async function query(sql, params = []) {
  if (isPostgres) {
    let count = 0;
    const pgSql = sql.replace(/\?/g, () => {
      count++;
      return `$${count}`;
    });
    const res = await pgPool.query(pgSql, params);
    return res.rows;
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }
}

/**
 * Executes an INSERT, UPDATE, or CREATE TABLE statement.
 */
async function run(sql, params = []) {
  if (isPostgres) {
    return query(sql, params);
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.run(sql, params, function(err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
}

module.exports = { query, run, isPostgres };
