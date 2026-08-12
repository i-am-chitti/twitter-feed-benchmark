const express = require('express');
const router = express.Router();
const db = require('../db');
const redis = require('../cache');
const config = require('../config');
const schema = require('../schema');
const { makeRng, makeZipf, shuffle } = require('../lib/rng');
const { recompute } = require('../lib/celebrities');

/** Accumulates Redis commands and flushes every `size` of them. */
function batcher(size = 10000) {
  let pipe = redis.pipeline();
  let n = 0;
  return {
    async add(fn) {
      fn(pipe);
      if (++n >= size) {
        await pipe.exec();
        pipe = redis.pipeline();
        n = 0;
      }
    },
    async flush() {
      if (n) {
        await pipe.exec();
        pipe = redis.pipeline();
        n = 0;
      }
    },
  };
}

/** Power-law follow graph. Returns edges plus a followee -> followers index. */
function buildGraph(rng) {
  const sample = makeZipf(config.userCount, config.zipfExponent, rng);
  const edges = [];
  const followers = new Map();

  for (let follower = 1; follower <= config.userCount; follower++) {
    const chosen = new Set();
    let guard = config.followsPerUser * 20;
    while (chosen.size < config.followsPerUser && guard-- > 0) {
      const followee = sample();
      if (followee !== follower) chosen.add(followee);
    }
    for (const followee of chosen) {
      edges.push([follower, followee]);
      if (!followers.has(followee)) followers.set(followee, []);
      followers.get(followee).push(follower);
    }
  }
  return { edges, followers };
}

/**
 * One globally unique created_at per tweet, one second apart, with authorship shuffled across
 * the slots.
 *
 * The old seeder took timestamps from `Date.now()` inside the insert loop, so ordering depended
 * on how fast seeding ran — celebrities were seeded first and were therefore always the oldest
 * tweets, which meant the hybrid merge was decided by sub-second jitter. Unique timestamps also
 * mean ZSET score order and SQL `ORDER BY created_at DESC` are identical with no ties, which is
 * what makes push/pull parity exactly testable.
 */
function buildTimeline(rng) {
  const authors = [];
  for (let user = 1; user <= config.userCount; user++) {
    for (let k = 0; k < config.tweetsPerUser; k++) authors.push(user);
  }
  shuffle(authors, rng);

  const base = Date.now();
  return authors.map((user_id, i) => ({
    id: i + 1,
    user_id,
    content: `Tweet ${i + 1} from user ${user_id}`,
    created_at: base - (authors.length - i) * 1000,
  }));
}

router.post('/seed', async (req, res) => {
  const started = Date.now();
  const timings = {};
  const step = async (name, fn) => {
    const t = Date.now();
    const out = await fn();
    timings[name] = Date.now() - t;
    console.log(`[seed] ${name} ${timings[name]}ms`);
    return out;
  };

  try {
    const rng = makeRng(config.seed);

    await step('reset', async () => {
      await redis.flushdb();
      await schema.resetSchema();
    });

    const { edges, followers } = await step('graph', async () => buildGraph(rng));
    const tweets = await step('timeline', async () => buildTimeline(rng));

    await step('insert_follows', () =>
      db.transaction((tx) => db.insertBatch(tx, 'follows', ['follower_id', 'followee_id'], edges))
    );
    await step('insert_tweets', () =>
      db.transaction((tx) =>
        db.insertBatch(
          tx,
          'tweets',
          ['id', 'user_id', 'content', 'created_at'],
          tweets.map((t) => [t.id, t.user_id, t.content, t.created_at])
        )
      )
    );
    await redis.set(redis.keys.tweetSeq, tweets.length);

    const celebrityIds = await step('celebrities', () => recompute());
    const celebs = new Set(celebrityIds);

    // Tier 2: one copy of each tweet body.
    await step('content_cache', async () => {
      const b = batcher();
      for (const t of tweets) {
        await b.add((p) =>
          p.set(redis.keys.tweet(t.id), JSON.stringify(t), 'EX', config.tweetTtlSeconds)
        );
      }
      await b.flush();
    });

    // Tier 1: fan out standard-account tweets. Celebrity tweets are served on read.
    const fanout = await step('fanout', async () => {
      const b = batcher();
      const touched = new Set();
      let writes = 0;
      let skipped = 0;

      for (const t of tweets) {
        if (celebs.has(t.user_id)) {
          skipped++;
          continue;
        }
        for (const followerId of followers.get(t.user_id) || []) {
          const key = redis.keys.feed(followerId);
          touched.add(key);
          writes++;
          await b.add((p) => p.zadd(key, t.created_at, t.id));
        }
      }
      await b.flush();

      // One trim pass at the end, rather than a ZREMRANGEBYRANK after every ZADD.
      const trim = batcher();
      for (const key of touched) {
        await trim.add((p) => p.zremrangebyrank(key, 0, -(config.feedDepth + 1)));
      }
      await trim.flush();

      return { writes, skipped, feeds: touched.size };
    });

    const counts = [...followers.values()].map((f) => f.length).sort((a, b) => a - b);
    const pct = (p) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] || 0;

    res.json({
      success: true,
      elapsedMs: Date.now() - started,
      timings,
      dataset: {
        users: config.userCount,
        tweets: tweets.length,
        followEdges: edges.length,
        seed: config.seed,
        zipfExponent: config.zipfExponent,
      },
      followerCounts: {
        max: counts[counts.length - 1] || 0,
        p50: pct(0.5),
        p90: pct(0.9),
        p99: pct(0.99),
        mean: Number((edges.length / config.userCount).toFixed(2)),
      },
      hybrid: {
        threshold: config.celebThreshold,
        celebrityCount: celebrityIds.length,
        celebrityIds,
      },
      fanout,
    });
  } catch (err) {
    console.error('[seed]', err);
    res.status(500).json({ error: 'seed_failed', detail: err.message });
  }
});

module.exports = router;
