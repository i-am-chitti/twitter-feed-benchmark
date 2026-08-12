const express = require('express');
const router = express.Router();
const db = require('../db');
const redis = require('../cache');
const config = require('../config');
const schema = require('../schema');

router.post('/seed', async (req, res) => {
  try {
    console.log("Starting DB seeding...");

    await redis.flushdb();
    await schema.resetSchema();

    const userCount = config.userCount;
    const celebrityIds = config.celebrityIds;
    
    // 1. Create Follow Graph relationships
    console.log("Seeding follow graph...");
    await db.run("BEGIN TRANSACTION;");
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
        await db.run("INSERT INTO follows (follower_id, followee_id) VALUES (?, ?) ON CONFLICT DO NOTHING;", [i, followeeId]);
      }
    }
    await db.run("COMMIT;");

    // 2. Generate Tweets & Populate ZSETs
    console.log("Seeding tweets & cache...");
    let tweetIdCounter = 1;
    
    await db.run("BEGIN TRANSACTION;");
    for (let i = 1; i <= userCount; i++) {
      const tweetCount = celebrityIds.includes(i) ? 100 : 30; // Celebrities post more frequently
      const isCeleb = celebrityIds.includes(i);

      for (let t = 0; t < tweetCount; t++) {
        const tweetText = `This is tweet #${t} by user #${i}. System design rules!`;
        const createdAt = Date.now() - (tweetCount - t) * 60000; // epoch millis
        
        // Ids are assigned here, not by the database, so Redis and the table can never drift.
        const dbId = tweetIdCounter++;
        await db.run("INSERT INTO tweets (id, user_id, content, created_at) VALUES (?, ?, ?, ?);", [dbId, i, tweetText, createdAt]);

        const tweetPayload = {
          id: dbId,
          user_id: i,
          content: tweetText,
          created_at: createdAt
        };

        // Cache the raw Tweet Content globally (Tier 2 Cache)
        await redis.set(redis.keys.tweet(dbId), JSON.stringify(tweetPayload), 'EX', config.tweetTtlSeconds);

        // Push Model logic: Only push to feeds if the author is NOT a celebrity
        if (!isCeleb) {
          // Find all followers of this user
          const followers = await db.query("SELECT follower_id FROM follows WHERE followee_id = ?;", [i]);
          
          // Pipeline the Redis writes
          const pipeline = redis.pipeline();
          for (const f of followers) {
            const feedKey = redis.keys.feed(f.follower_id);

            pipeline.zadd(feedKey, createdAt, dbId);
            pipeline.zremrangebyrank(feedKey, 0, -801); // Keep trimmed to 800
          }
          await pipeline.exec();
        }
      }
    }
    await db.run("COMMIT;");

    // Keep the id counter in lockstep with the table so a re-seed stays idempotent.
    await redis.set(redis.keys.tweetSeq, tweetIdCounter - 1);

    res.json({ success: true, message: `DB Seeded successfully with ${userCount} users, follow graph, and tweets.` });
  } catch (error) {
    console.error("Seeding error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
