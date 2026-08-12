const express = require('express');
const router = express.Router();
const db = require('../db');
const redis = require('../cache');
const config = require('../config');
const { getCelebritySet } = require('../lib/celebrities');

// ----------------------------------------------------
// ROUTE: PULL MODEL FEED (On-the-fly SQL Joins)
// ----------------------------------------------------
router.get('/pull', async (req, res) => {
  const userId = parseInt(req.query.userId) || 5;

  try {
    // 1. Fetch all followed accounts from Database
    const followees = await db.query("SELECT followee_id FROM follows WHERE follower_id = ?;", [userId]);
    const followeeIds = followees.map(f => f.followee_id);

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

    res.json(feedTweets);
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

  try {
    // 1. Read pre-computed feed from user's ZSET cache (contains non-celeb tweets)
    const cachedTweetIds = await redis.zrevrange(redis.keys.feed(userId), 0, 19);

    let cachedTweets = [];
    if (cachedTweetIds.length > 0) {
      const keys = cachedTweetIds.map(id => redis.keys.tweet(id));

      // Fetch all contents in a single MGET pipeline round-trip
      const rawTweets = await redis.mget(keys);
      cachedTweets = rawTweets
        .filter(t => t !== null)
        .map(t => JSON.parse(t));
    }

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

    // 3. Merge & Sort the Push and Pull streams in memory.
    // created_at is epoch millis on both sides, so this is a numeric compare with id as a
    // deterministic tiebreaker — no date parsing, no timezone to get wrong.
    const mergedFeed = [...cachedTweets, ...celebrityTweets];
    mergedFeed.sort((a, b) => b.created_at - a.created_at || b.id - a.id);

    // Slice to page size
    const finalFeed = mergedFeed.slice(0, 20);

    res.json(finalFeed);
  } catch (error) {
    console.error("Push Feed Error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
