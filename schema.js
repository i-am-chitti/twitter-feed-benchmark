const db = require('./db');

/**
 * `created_at` is BIGINT epoch millis, not TIMESTAMP.
 *
 * The previous schema used TIMESTAMP (without time zone) and inserted ISO strings ending in
 * `Z`. PostgreSQL discards the offset for that column type and node-pg rebuilds the value as a
 * *local* Date, so in IST every DB-sourced timestamp came back 5h30m behind the same tweet's
 * Redis-cached copy. The hybrid merge sorted every celebrity tweet out of the page.
 *
 * Epoch millis removes the class of bug, and is the exact value used as the ZSET score — so
 * the cache and the database cannot disagree about ordering.
 */
const TWEETS = {
  postgres: `CREATE TABLE IF NOT EXISTS tweets (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  sqlite: `CREATE TABLE IF NOT EXISTS tweets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
};

const FOLLOWS = `CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
)`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id, followee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id, follower_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tweets_user_time ON tweets(user_id, created_at DESC)`,
];

async function ensureSchema() {
  await db.run(FOLLOWS);
  await db.run(TWEETS[db.isPostgres ? 'postgres' : 'sqlite']);
  for (const stmt of INDEXES) await db.run(stmt);
}

/** Drop and recreate, so a re-seed is a clean slate rather than a partial overwrite. */
async function resetSchema() {
  await db.run('DROP TABLE IF EXISTS tweets');
  await db.run('DROP TABLE IF EXISTS follows');
  await ensureSchema();
}

module.exports = { ensureSchema, resetSchema };
