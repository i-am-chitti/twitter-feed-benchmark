const test = require('node:test');
const assert = require('node:assert');

/**
 * Push and pull must return the same page.
 *
 * This is the gate for every performance number in the writeup: comparing two architectures is
 * only meaningful if they do equal work. Two bugs that this catches, both of which silently
 * corrupted earlier benchmark runs:
 *
 *  - created_at stored as a naive TIMESTAMP, which shifted DB-sourced tweets by the local UTC
 *    offset and sorted every celebrity out of the push page
 *  - tweet ids from a DB sequence that does not reset on re-seed, so Redis and the table
 *    described different tweets
 *
 * Requires a seeded server. TARGET_URL and API_KEY are honoured.
 */
// Requiring config loads .env, so the test resolves TARGET_URL and API_KEY exactly the way
// benchmark.js does. Without it the test silently fell back to localhost while the benchmark
// ran against the deployed stack.
const config = require('../config');

const target = process.env.TARGET_URL || 'http://localhost:3000';
const headers = config.apiKey ? { 'x-api-key': config.apiKey } : {};
const USERS = [5, 20, 77, 150, 251, 400, 613, 900, 999];

const feed = async (model, userId) => {
  const res = await fetch(`${target}/feed/${model}?userId=${userId}`, { headers });
  assert.equal(res.status, 200, `${model} returned ${res.status}`);
  return res.json();
};

test('push and pull return identical pages', async () => {
  for (const userId of USERS) {
    const [pull, push] = await Promise.all([feed('pull', userId), feed('push', userId)]);

    assert.ok(pull.length > 0, `user ${userId}: pull page is empty`);
    assert.deepEqual(
      push.map((t) => t.id),
      pull.map((t) => t.id),
      `user ${userId}: push and pull disagree`
    );
  }
});

test('the hybrid merge actually contributes celebrity tweets', async () => {
  const seen = await Promise.all(USERS.map((u) => feed('push', u)));
  const authors = new Set(seen.flat().map((t) => t.user_id));

  // Celebrities are the low-numbered ids under a Zipf graph. If none of them appear anywhere,
  // the pull half of the hybrid is dead weight and the benchmark is measuring one model twice.
  assert.ok(
    [...authors].some((id) => id <= 20),
    'no celebrity tweets in any push page — the hybrid merge is not contributing'
  );
});

test('a cold feed cache is visible rather than silently empty', async () => {
  const page = await feed('push', 150);
  assert.ok(page.length > 0, 'push page empty — feed cache may be unpopulated');
  assert.ok(
    page.every((t) => typeof t.created_at === 'number'),
    'created_at must be epoch millis on both paths'
  );
});
