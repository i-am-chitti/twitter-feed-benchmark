const express = require('express');
const router = express.Router();
const db = require('../db');
const redis = require('../cache');
const config = require('../config');

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
      ORDER BY created_at DESC 
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
    const cachedTweetIds = await redis.zrevrange(`feed:${userId}`, 0, 19);

    let cachedTweets = [];
    if (cachedTweetIds.length > 0) {
      const keys = cachedTweetIds.map(id => `tweet:${id}`);
      
      // Fetch all contents in a single MGET pipeline round-trip
      const rawTweets = await redis.mget(keys);
      cachedTweets = rawTweets
        .filter(t => t !== null)
        .map(t => JSON.parse(t));
    }

    // 2. Fetch followed celebrities
    const followees = await db.query("SELECT followee_id FROM follows WHERE follower_id = ?;", [userId]);
    
    // Filter to celebrity IDs (defined in config)
    const celebFollowees = followees
      .map(f => f.followee_id)
      .filter(id => config.celebrityIds.includes(id));

    let celebrityTweets = [];
    if (celebFollowees.length > 0) {
      // Pull celebrity tweets dynamically from DB on the fly (Hybrid Model)
      const placeholders = celebFollowees.map(() => '?').join(',');
      celebrityTweets = await db.query(`
        SELECT * FROM tweets
        WHERE user_id IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT 20;
      `, celebFollowees);
    }

    // 3. Merge & Sort the Push and Pull streams in memory
    const mergedFeed = [...cachedTweets, ...celebrityTweets];
    mergedFeed.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    
    // Slice to page size
    const finalFeed = mergedFeed.slice(0, 20);

    res.json(finalFeed);
  } catch (error) {
    console.error("Push Feed Error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
