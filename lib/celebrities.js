const db = require('../db');
const redis = require('../cache');
const config = require('../config');

// The hybrid cutoff, derived from the follow graph rather than a hardcoded list of ids.
// Computed at seed time, stored in Redis, cached in-process so the read path does not pay a
// round trip per request. Cost of that cache: an account crossing the threshold keeps being
// fanned out to for up to one TTL.
let cached = { ids: null, at: 0 };

const KEY = 'celebs';

async function recompute() {
  const rows = await db.query(
    'SELECT followee_id FROM follows GROUP BY followee_id HAVING COUNT(*) >= ?',
    [config.celebThreshold]
  );
  const ids = rows.map((r) => Number(r.followee_id));

  await redis.del(KEY);
  if (ids.length) await redis.sadd(KEY, ...ids);

  cached = { ids: new Set(ids), at: Date.now() };
  return ids;
}

async function getCelebritySet() {
  if (cached.ids && Date.now() - cached.at < config.celebCacheTtlMs) return cached.ids;
  const ids = await redis.smembers(KEY);
  cached = { ids: new Set(ids.map(Number)), at: Date.now() };
  return cached.ids;
}

module.exports = { recompute, getCelebritySet };
