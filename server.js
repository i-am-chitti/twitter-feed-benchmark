const express = require('express');
const Redis = require('ioredis');
const db = require('./db');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Redis client
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);

// Config parameters
const CELEB_THRESHOLD = 500; // Users with >= 500 followers are celebrities

// Setup DB Tables and Indexes
async function initDb() {
  console.log("Initializing database tables...");
  
  if (db.isPostgres) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS follows (
        follower_id INT,
        followee_id INT,
        PRIMARY KEY (follower_id, followee_id)
      );
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS tweets (
        id SERIAL PRIMARY KEY,
        user_id INT,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS follows (
        follower_id INTEGER,
        followee_id INTEGER,
        PRIMARY KEY (follower_id, followee_id)
      );
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS tweets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // Create Indexes for SQL performance
  try {
    await db.run("CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);");
    await db.run("CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);");
    await db.run("CREATE INDEX IF NOT EXISTS idx_tweets_user_time ON tweets(user_id, created_at DESC);");
    console.log("Database initialized with indexes.");
  } catch (err) {
    console.warn("Index creation warning (might already exist):", err.message);
  }
}

// ----------------------------------------------------
// ROUTE: SEED DATABASE
// ----------------------------------------------------
app.post('/seed', async (req, res) => {
  try {
    console.log("Starting DB seeding...");
    
    // Clear Redis caches
    await redis.flushall();
    
    // Clear Database tables
    await db.run("DELETE FROM follows;");
    await db.run("DELETE FROM tweets;");

    const userCount = 1000; // 1,000 active users for simulation
    const celebrityIds = [1, 2, 3]; // Specific celebrity accounts
    
    // 1. Create Follow Graph relationships
    console.log("Seeding follow graph...");
    for (let i = 4; i <= userCount; i++) {
      // Every standard user follows the 3 celebrities
      for (const celebId of celebrityIds) {
        await db.run("INSERT INTO follows (follower_id, followee_id) VALUES (?, ?);", [i, celebId]);
      }
      
      // Every standard user follows 20 other random standard users
      const followsSet = new Set();
      while (followsSet.size < 20) {
        const randUser = Math.floor(Math.random() * (userCount - 4)) + 4;
        if (randUser !== i) followsSet.add(randUser);
      }
      for (const followeeId of followsSet) {
        await db.run("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?);", [i, followeeId]);
      }
    }

    // 2. Generate 50,000 Tweets
    console.log("Seeding tweets & cache...");
    let tweetIdCounter = 1;
    
    for (let i = 1; i <= userCount; i++) {
      const tweetCount = celebrityIds.includes(i) ? 100 : 30; // Celebrities post more frequently
      const isCeleb = celebrityIds.includes(i);

      for (let t = 0; t < tweetCount; t++) {
        const tweetText = `This is tweet #${t} by user #${i}. System design rules!`;
        const createdAt = new Date(Date.now() - (tweetCount - t) * 60000).toISOString();
        
        // Insert into database
        await db.run("INSERT INTO tweets (user_id, content, created_at) VALUES (?, ?, ?);", [i, tweetText, createdAt]);
        const dbId = tweetIdCounter++;
        
        const tweetPayload = {
          id: dbId,
          user_id: i,
          content: tweetText,
          created_at: createdAt
        };

        // Cache the raw Tweet Content globally (Tier 2 Cache)
        await redis.set(`tweet:${dbId}`, JSON.stringify(tweetPayload));

        // Push Model logic: Only push to feeds if the author is NOT a celebrity
        if (!isCeleb) {
          // Find all followers of this user
          const followers = await db.query("SELECT follower_id FROM follows WHERE followee_id = ?;", [i]);
          
          // Pipeline the Redis writes to S3/Redis for bulk execution speed
          const pipeline = redis.pipeline();
          for (const f of followers) {
            const feedKey = `feed:${f.follower_id}`;
            const score = new Date(createdAt).getTime();
            
            pipeline.zadd(feedKey, score, dbId);
            // Keep feed size trimmed to latest 800
            pipeline.zremrangebyrank(feedKey, 0, -801);
          }
          await pipeline.exec();
        }
      }
    }

    res.json({ success: true, message: "DB Seeded successfully with 1000 users, follow graph, and 30k+ tweets." });
  } catch (error) {
    console.error("Seeding error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// ROUTE: PULL MODEL FEED (On-the-fly SQL Joins)
// ----------------------------------------------------
app.get('/feed/pull', async (req, res) => {
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
app.get('/feed/push', async (req, res) => {
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
    const celebFollowees = followees.map(f => f.followee_id).filter(id => id <= 3); // IDs 1, 2, 3 are celebs

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

// Start server and initialize tables
initDb().then(() => {
  app.listen(port, () => {
    console.log(`System design benchmark API listening at http://localhost:${port}`);
  });
});
