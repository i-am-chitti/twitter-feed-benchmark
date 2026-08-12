const autocannon = require('autocannon');
const config = require('./config');

const target = process.env.TARGET_URL || 'http://localhost:3000';
const headers = config.apiKey ? { 'x-api-key': config.apiKey } : {};

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'read';
const flag = (name, d) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : d;
};
const nums = (s) => String(s).split(',').map(Number);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function api(path, init = {}) {
  const res = await fetch(`${target}${path}`, {
    ...init,
    headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------------------------------
async function seed() {
  const body = await api('/seed', { method: 'POST' });
  console.log(JSON.stringify(body, null, 2));
}

// ---------------------------------------------------------------------------
// READ PATH
//
// Two things this fixes about the earlier runs:
//
//  - It sweeps concurrency instead of testing one point. A single closed-loop run at 400
//    connections is saturated, and at saturation avg latency is just concurrency / throughput
//    — so "23% lower latency" and "30% higher throughput" were one measurement reported twice.
//    The `implied rps` column makes that visible: when it matches measured rps, the number
//    is queueing delay, not service time.
//  - It randomises userId and alternates model order across repeats, so one hot Redis key and
//    one warm query plan stop standing in for a real access pattern.
//
// --rate switches to open loop, which is the only way to get a latency number that is not a
// function of the load generator's own backlog.
async function read() {
  const conns = nums(flag('conns', '10,50,100,400'));
  const duration = Number(flag('duration', 10));
  const repeats = Number(flag('repeat', 3));
  const rate = flag('rate', null) && Number(flag('rate'));
  const users = Number(flag('users', config.userCount));

  console.log(
    `target=${target} conns=[${conns}] duration=${duration}s repeats=${repeats} ` +
      `mode=${rate ? `open-loop @${rate}rps` : 'closed-loop'} users=1..${users}\n`
  );

  const runOne = (model, connections) => {
    const path = `/feed/${model}`;
    const opts = {
      url: target,
      connections,
      duration,
      headers,
      requests: [
        {
          method: 'GET',
          setupRequest: (req) => ({
            ...req,
            path: `${path}?userId=${1 + Math.floor(Math.random() * users)}`,
          }),
        },
      ],
    };
    if (rate) opts.overallRate = rate;
    return autocannon(opts);
  };

  const rows = [];
  for (const connections of conns) {
    const runs = { pull: [], push: [] };

    for (let i = 0; i < repeats; i++) {
      // Alternate order so warm-cache and warm-plan effects cancel out.
      for (const model of i % 2 === 0 ? ['pull', 'push'] : ['push', 'pull']) {
        if (process.stdout.isTTY) {
          process.stdout.write(`  ${connections} conns  ${model}  run ${i + 1}/${repeats}\r`);
        }
        runs[model].push(await runOne(model, connections));
      }
    }

    for (const model of ['pull', 'push']) {
      const rs = runs[model];
      const avg = median(rs.map((r) => r.latency.average));
      const rps = median(rs.map((r) => r.requests.average));
      const errors = rs.reduce((n, r) => n + r.non2xx + r.errors, 0);

      rows.push({
        conns: connections,
        model,
        'rps (med)': Math.round(rps),
        'avg ms': +avg.toFixed(2),
        'p50 ms': median(rs.map((r) => r.latency.p50)),
        'p99 ms': median(rs.map((r) => r.latency.p99)),
        'implied rps': Math.round(connections / (avg / 1000)),
        'rps spread': `${Math.round(Math.min(...rs.map((r) => r.requests.average)))}-${Math.round(
          Math.max(...rs.map((r) => r.requests.average))
        )}`,
        errors,
      });
    }
  }

  console.log('\n');
  console.table(rows);
  console.log(
    'If `implied rps` tracks `rps (med)`, the run is saturated and `avg ms` is queueing delay.\n' +
      'Compare models at the same conns, and read service latency from the lowest conns row.\n'
  );
}

// ---------------------------------------------------------------------------
// WRITE PATH
//
// The cost the hybrid design exists to avoid, and the one the earlier writeup asserted without
// measuring. Fan-out scales with follower count, not tweet count, so this is measurable on
// cheap infrastructure. Probe ids double each step; under a Zipf graph id ~ rank, so this spans
// the follower distribution. `forceFanout` ignores the celebrity cutoff, which is the point —
// we want what push *would* have cost.
//
// Note: this writes real tweets. Re-seed before running the read benchmark.
async function fanout() {
  const probes = nums(flag('probes', '1,2,4,8,16,32,64,128,256,512,900'));
  const repeats = Number(flag('repeat', 5));

  console.log(`target=${target} probes=[${probes}] repeats=${repeats}\n`);

  const rows = [];
  for (const userId of probes) {
    const samples = [];
    let followers = 0;
    for (let i = 0; i < repeats; i++) {
      const r = await api('/tweet', {
        method: 'POST',
        body: JSON.stringify({ userId, content: `fanout probe ${i}`, forceFanout: true }),
      });
      samples.push(r.fanout.ms);
      followers = r.fanout.followers;
    }
    const med = median(samples);
    rows.push({
      userId,
      followers,
      'fanout ms (med)': +med.toFixed(2),
      'us per follower': followers ? +((med * 1000) / followers).toFixed(1) : 0,
      'ms spread': `${Math.min(...samples).toFixed(1)}-${Math.max(...samples).toFixed(1)}`,
    });
  }

  rows.sort((a, b) => a.followers - b.followers);
  console.table(rows);
  console.log(
    'Extrapolate: a write at F followers costs roughly F x (us per follower).\n' +
      'Fleet-wide steady state = write QPS x mean followers ZADDs/sec.\n'
  );
}

// ---------------------------------------------------------------------------
const commands = { seed, read, fanout };

if (!commands[cmd]) {
  console.error(`usage: node benchmark.js <${Object.keys(commands).join('|')}> [flags]`);
  process.exit(1);
}

commands[cmd]().catch((err) => {
  console.error(`${cmd} failed:`, err.message);
  process.exit(1);
});
