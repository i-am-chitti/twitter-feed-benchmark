# Twitter News Feed: Push vs. Pull Benchmark

A small, honest benchmark of the two classic timeline architectures — **push (fan-out on write)**
and **pull (fan-out on read)** — plus the **hybrid** that serves high-follower accounts on read.

This is a measurement harness, not a feed product. It exists to produce numbers a writeup can
cite instead of assert. It does not attempt production scale; see *Limits* below.

---

## What it measures

| Mode | Question |
| :--- | :--- |
| `read` | How do push and pull compare as concurrency rises — and at what point is the number just queueing delay? |
| `fanout` | What does fan-out on write cost as follower count grows? This is the cost the hybrid design exists to avoid. |

The read benchmark sweeps concurrency, randomises `userId` per request, alternates model order
across repeats, and reports an **`implied rps`** column (`connections / avg latency`). When that
column tracks measured rps, the run is saturated and `avg ms` is queueing delay rather than
service time — a single-point closed-loop test cannot tell you the difference.

`--rate=N` switches to open loop, which is the only way to read latency independent of the load
generator's own backlog.

---

## Architecture under test

* **Standard accounts → push.** On write, the tweet id is fanned out into every follower's Redis
  sorted set (`feed:{userId}`, score = `created_at`, member = `tweetId`).
* **High-follower accounts → pull.** Their tweets are not fanned out. The read path queries them
  live and merges.
* **Two-tier cache.** Tier 1 is the sorted set (structure only). Tier 2 is `tweet:{id}` holding
  one copy of each body globally, so a viral tweet is stored once rather than per follower.

The celebrity cutoff is **derived** from the follow graph (`CELEB_THRESHOLD` followers), not a
hardcoded id list. The seeded graph draws followees from a Zipf distribution, so follower counts
follow a power law and the celebrity problem is present in the data rather than assumed.

---

## Run it

```bash
docker compose up --build -d     # api + redis
npm run seed                     # seed graph, timeline, caches
npm test                         # push/pull parity — run this before trusting any number
npm run benchmark                # read sweep
npm run fanout                   # write-path curve
```

Against a deployed stack:

```bash
export TARGET_URL=https://your-app.onrender.com API_KEY=...
npm run seed && npm test && npm run benchmark
```

Useful flags:

```bash
node benchmark.js read --conns=1,10,50,100,400 --duration=30 --repeat=3
node benchmark.js read --conns=100 --rate=200          # open loop
node benchmark.js fanout --probes=1,4,16,64,256 --repeat=5
```

`npm run fanout` writes real tweets. Re-seed before running the read benchmark again.

Feed cache memory, for extrapolating the RAM bill:

```bash
redis-cli memory usage feed:150
```

---

## Configuration

All env-driven, so the dataset can be scaled without editing source.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `SEED` | `42` | Deterministic dataset — same seed, same graph and timeline |
| `USER_COUNT` | `1000` | Users who tweet and read |
| `TWEETS_PER_USER` | `30` | Timeline depth |
| `FOLLOWS_PER_USER` | `20` | Out-degree |
| `ZIPF_EXPONENT` | `1.0` | Skew of the follower distribution |
| `CELEB_THRESHOLD` | `200` | Followers at which an account is served on read |
| `FEED_DEPTH` | `800` | Sorted-set trim depth |
| `TRIM_PROBABILITY` | `0.05` | Trim on ~1 in 20 fan-out writes rather than every one |
| `PG_POOL_MAX` | `10` | **Control for this.** A small pool limits the pull path and is easily mistaken for an architectural result |
| `TWEET_TTL_SECONDS` | `604800` | Tier-2 body TTL |

---

## Correctness gate

`npm test` asserts push and pull return **identical pages**. Comparing two architectures only
means something if they do equal work, and three bugs found here had silently broken that:

* `created_at` stored as a naive `TIMESTAMP` — PostgreSQL dropped the ISO offset and node-pg
  rebuilt it as a local `Date`, shifting DB-sourced tweets by the local UTC offset and sorting
  every celebrity out of the push page. Now BIGINT epoch millis, the same value used as the
  sorted-set score.
* Tweet ids from a database sequence, which does not reset on `DELETE FROM tweets` — a re-seed
  left Redis holding ids `1..N` while the table held `N+1..2N`. Now assigned from `tweet:seq`.
* The hybrid merge did not dedupe, so a tweet reachable from both halves appeared twice.

Run it before every benchmark, local or deployed.

---

## Limits

Worth stating plainly, because they bound what the numbers support:

* **Scale.** 1,000 users and 30,000 tweets on small instances. Enough to show fan-out cost and
  saturation behaviour; **not** enough to demonstrate that pull degrades at production data
  volume. That claim needs millions of rows and is not reachable here.
* **Reverse-chronological only.** No ranking layer.
* **No async fan-out.** Writes fan out inline. Production enqueues to a worker pool; that
  changes the write-latency picture substantially.
* **No delete, unfollow, or block handling.** Each is a real push-model cost this does not pay.
* **No rebuild-on-miss.** An evicted `feed:{userId}` returns a short page. Deliberately left
  out of scope.
* **Load generator location matters.** Driving a deployed target from a laptop puts internet RTT
  and TLS into every sample, identical for both models but diluting the difference.
