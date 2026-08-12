const express = require('express');
const router = express.Router();
const db = require('../db');
const redis = require('../cache');
const config = require('../config');
const { getCelebritySet } = require('../lib/celebrities');

/**
 * Per-stage timings, emitted as a Server-Timing header.
 *
 * Without this, explaining a latency number means guessing at it — the earlier writeup blamed
 * a P99 spike on JSON parsing in one place and GC pauses in another, with no data for either.
 */
function clock() {
  let last = process.hrtime.bigint();
  const stages = {};
  return {
    mark(name) {
      const now = process.hrtime.bigint();
      stages[name] = Number(now - last) / 1e6;
      last = now;
    },
    send(res, body) {
      res.set(
        'Server-Timing',
        Object.entries(stages)
          .map(([k, v]) => `${k};dur=${v.toFixed(2)}`)
          .join(', ')
      );
      res.json(body);
    },
  };
}

// ----------------------------------------------------
// ROUTE: PULL MODEL FEED (On-the-fly SQL Joins)
// ----------------------------------------------------
router.get('/pull', async (req, res) => {
  const userId = parseInt(req.query.userId) || 5;
  const t = clock();

  try {
    // 1. Fetch all followed accounts from Database
    const followees = await db.query("SELECT followee_id FROM follows WHERE follower_id = ?;", [userId]);
    const followeeIds = followees.map(f => f.followee_id);
    t.mark('sql_follows');

    if (followeeIds.length === 0) {
      return res.json([]);
    }

    // 2. Query all latest tweets by those followed accounts in database directly
    const placeholders = followeeIds.map(() => '?').join(',');
    const feedTweets = await db.query(`
      SELECT * FROM tweets 
      WHERE user_id IN (${placeholders}) 
      ORDER BY created_at DESC, id DESC
      LIMIT 20;
    `, followeeIds);
    t.mark('sql_tweets');

    t.send(res, feedTweets);
  } catch (error) {
    console.error("Pull Feed Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// ROUTE: PUSH MODEL FEED (Redis ZSET Cache + Celebrity Hybrid Merge)
// ----------------------------------------------------
router.get('/push', async (req, res) => {
  const userId = parseInt(req.query.userId) || 5;
  const t = clock();

  try {
    // 1. Read pre-computed feed from user's ZSET cache (contains non-celeb tweets)
    const cachedTweetIds = await redis.zrevrange(redis.keys.feed(userId), 0, 19);
    t.mark('redis_zrange');

    let cachedTweets = [];
    if (cachedTweetIds.length > 0) {
      const keys = cachedTweetIds.map(id => redis.keys.tweet(id));

      // Fetch all contents in a single MGET pipeline round-trip
      const rawTweets = await redis.mget(keys);
      cachedTweets = rawTweets
        .filter(raw => raw !== null)
        .map(raw => JSON.parse(raw));
    }
    t.mark('redis_mget');

    // 2. Fetch followed celebrities
    const followees = await db.query("SELECT followee_id FROM follows WHERE follower_id = ?;", [userId]);

    // Filter to celebrities, derived from follower counts at seed time
    const celebs = await getCelebritySet();
    const celebFollowees = followees
      .map(f => Number(f.followee_id))
      .filter(id => celebs.has(id));

    let celebrityTweets = [];
    if (celebFollowees.length > 0) {
      // Pull celebrity tweets dynamically from DB on the fly (Hybrid Model)
      const placeholders = celebFollowees.map(() => '?').join(',');
      celebrityTweets = await db.query(`
        SELECT * FROM tweets
        WHERE user_id IN (${placeholders})
        ORDER BY created_at DESC, id DESC
        LIMIT 20;
      `, celebFollowees);
    }
    t.mark('sql_celebrity');

    // 3. Merge & Sort the Push and Pull streams in memory.
    // created_at is epoch millis on both sides, so this is a numeric compare with id as a
    // deterministic tiebreaker — no date parsing, no timezone to get wrong.
    //
    // Dedupe by id: the two halves can overlap. An account that crosses the celebrity
    // threshold still has earlier tweets sitting in follower ZSETs, and the in-process
    // celebrity cache means the cutoff moves later for some requests than others. Either way
    // the same tweet arrives from the cache and the pull, and the page shows it twice.
    const byId = new Map();
    for (const tweet of [...cachedTweets, ...celebrityTweets]) byId.set(tweet.id, tweet);

    const mergedFeed = [...byId.values()]
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id);

    // Slice to page size
    const finalFeed = mergedFeed.slice(0, 20);
    t.mark('merge');

    t.send(res, finalFeed);
  } catch (error) {
    console.error("Push Feed Error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
