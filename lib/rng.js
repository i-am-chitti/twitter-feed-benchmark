// Seeded RNG so SEED=42 always produces the same dataset. A benchmark whose input changes
// between runs is not a benchmark.

/** mulberry32 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Samples ranks 1..n with weight 1/rank^exponent.
 *
 * Without this the graph is uniform — every account has the same follower count, so the
 * celebrity problem a hybrid feed exists to solve is absent from the dataset by construction.
 */
function makeZipf(n, exponent, rng) {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) cdf[i] = total += 1 / Math.pow(i + 1, exponent);
  for (let i = 0; i < n; i++) cdf[i] /= total;

  return () => {
    const r = rng();
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { makeRng, makeZipf, shuffle };
