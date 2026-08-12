const db = require('../db');
const redis = require('../cache');
const config = require('../config');
const { getCelebritySet } = require('./celebrities');

const CHUNK = 10000;

/**
 * Streams followers in keyset-paginated chunks.
 *
 * A single `SELECT follower_id WHERE followee_id = ?` is fine at 20 followers and a memory
 * problem at 5 million. Keyset pagination keeps the working set bounded whatever the count.
 */
async function* followerChunks(authorId) {
  let cursor = -1;
  for (;;) {
    const rows = await db.query(
      `SELECT follower_id FROM follows
        WHERE followee_id = ? AND follower_id > ?
        ORDER BY follower_id LIMIT ${CHUNK}`,
      [authorId, cursor]
    );
    if (!rows.length) return;
    yield rows.map((r) => Number(r.follower_id));
    cursor = Number(rows[rows.length - 1].follower_id);
    if (rows.length < CHUNK) return;
  }
}

/**
 * Fan-out on write. Trimming is probabilistic — a ZREMRANGEBYRANK after every ZADD doubles
 * the command count to enforce a bound that only needs to hold approximately.
 */
async function fanOut({ tweetId, authorId, createdAt }) {
  const started = process.hrtime.bigint();
  let followers = 0;
  let commands = 0;

  for await (const ids of followerChunks(authorId)) {
    const pipe = redis.pipeline();
    for (const followerId of ids) {
      const key = redis.keys.feed(followerId);
      pipe.zadd(key, createdAt, tweetId);
      commands++;
      if (Math.random() < config.trimProbability) {
        pipe.zremrangebyrank(key, 0, -(config.feedDepth + 1));
        commands++;
      }
    }
    await pipe.exec();
    followers += ids.length;
  }

  return { followers, commands, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/**
 * Full write path, with per-stage timings.
 *
 * `forceFanout` ignores the celebrity cutoff — that is how we measure what fan-out on write
 * *would* have cost for a high-follower account, which is the point of the fan-out curve.
 */
async function publishTweet({ userId, content, forceFanout = false }) {
  const mark = () => process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;

  const t0 = mark();
  const tweetId = await redis.incr(redis.keys.tweetSeq);
  const createdAt = Date.now();
  const t1 = mark();

  await db.run('INSERT INTO tweets (id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [
    tweetId,
    userId,
    content,
    createdAt,
  ]);
  const t2 = mark();

  const tweet = { id: tweetId, user_id: Number(userId), content, created_at: createdAt };
  await redis.set(redis.keys.tweet(tweetId), JSON.stringify(tweet), 'EX', config.tweetTtlSeconds);
  const t3 = mark();

  const celebrity = (await getCelebritySet()).has(Number(userId));
  const fanned = forceFanout || !celebrity;
  const fanout = fanned
    ? await fanOut({ tweetId, authorId: userId, createdAt })
    : { followers: 0, commands: 0, ms: 0 };
  const t4 = mark();

  return {
    tweet,
    celebrity,
    fannedOut: fanned,
    fanout,
    timings: {
      id: ms(t0, t1),
      dbInsert: ms(t1, t2),
      contentCache: ms(t2, t3),
      fanout: ms(t3, t4),
      total: ms(t0, t4),
    },
  };
}

module.exports = { publishTweet, fanOut };
