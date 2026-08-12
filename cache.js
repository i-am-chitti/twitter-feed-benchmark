const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

redis.on('connect', () => console.log('[redis] connected'));
redis.on('error', (err) => console.error('[redis] error:', err.message));

// feed:{userId}  ZSET   score = created_at (epoch ms), member = tweetId   (tier 1: structure)
// tweet:{id}     STRING JSON body, one copy globally                     (tier 2: content)
// tweet:seq      STRING monotonic tweet id counter
//
// Ids come from tweet:seq rather than a DB sequence. `DELETE FROM tweets` does not reset a
// SERIAL or sqlite_sequence, so re-seeding used to leave Redis holding ids 1..N while the
// table held N+1..2N — the two feed endpoints then served completely different data.
redis.keys = {
  feed: (userId) => `feed:${userId}`,
  tweet: (tweetId) => `tweet:${tweetId}`,
  tweetSeq: 'tweet:seq',
};

module.exports = redis;
