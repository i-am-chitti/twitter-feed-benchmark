require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(process.env.PORT, 3000),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  apiKey: process.env.API_KEY || null,

  // Dataset shape. Env-driven so the experiment can be scaled without editing source.
  seed: num(process.env.SEED, 42),
  userCount: num(process.env.USER_COUNT, 1000),
  tweetsPerUser: num(process.env.TWEETS_PER_USER, 30),
  followsPerUser: num(process.env.FOLLOWS_PER_USER, 20),
  zipfExponent: num(process.env.ZIPF_EXPONENT, 1.0),

  // Hybrid cutoff: accounts with >= this many followers are served by fan-out on read.
  celebThreshold: num(process.env.CELEB_THRESHOLD, 200),
  celebrityIds: [1, 2, 3], // superseded once celebrities are derived from the graph

  feedDepth: num(process.env.FEED_DEPTH, 800),
  pageSize: num(process.env.PAGE_SIZE, 20),
  tweetTtlSeconds: num(process.env.TWEET_TTL_SECONDS, 604800),
  trimProbability: num(process.env.TRIM_PROBABILITY, 0.05),

  // A confound to control for, not to accidentally benchmark.
  pgPoolMax: num(process.env.PG_POOL_MAX, 10),
  celebCacheTtlMs: num(process.env.CELEB_CACHE_TTL_MS, 30000),
};
