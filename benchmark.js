const autocannon = require('autocannon');
const http = require('http');
const config = require('./config');

// Configuration
const targetUrl = process.env.TARGET_URL || 'http://localhost:3000';
const testDuration = 10; // seconds
const connections = 100; // concurrent clients

// Helper: Make a POST request to seed the database
function seedDatabase() {
  return new Promise((resolve, reject) => {
    console.log(`[1/4] Triggering database seeding at ${targetUrl}/seed...`);
    const url = new URL(`${targetUrl}/seed`);
    
    const headers = config.apiKey ? { 'x-api-key': config.apiKey } : {};
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: '/seed',
      method: 'POST',
      headers: headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[2/4] Database seeding completed successfully.`);
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Seed failed with status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

// Helper: Run a load test on a specific path
function runLoadTest(path, name) {
  console.log(`[Load Test] Hammering ${targetUrl}${path} with ${connections} concurrent connections for ${testDuration}s...`);
  return new Promise((resolve, reject) => {
    autocannon({
      url: `${targetUrl}${path}`,
      connections: connections,
      duration: testDuration,
      pipelining: 1,
      headers: config.apiKey ? { 'x-api-key': config.apiKey } : {}
    }, (err, result) => {
      if (err) return reject(err);
      resolve({
        name,
        avgLatency: result.latency.average,
        p99Latency: result.latency.p99,
        rps: result.requests.average,
        throughput: (result.throughput.average / 1024 / 1024).toFixed(2) + ' MB/s',
        totalRequests: result.requests.sent
      });
    });
  });
}

async function main() {
  try {
    // 1. Seed DB first
    await seedDatabase();

    // 2. Wait 2 seconds for DB and Redis writes to settle
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`\n[3/4] Running benchmarks...\n`);

    // 3. Run Pull Model Load Test (SQL Query)
    const pullResult = await runLoadTest('/feed/pull?userId=120', 'Pull Model (SQL Query)');

    console.log('\n----------------------------------------\n');

    // 4. Run Push Model Load Test (Redis Cache + Hybrid Merge)
    const pushResult = await runLoadTest('/feed/push?userId=120', 'Push Model (Redis Cache + Hybrid)');

    // 5. Output comparison results in a beautiful table
    console.log(`\n[4/4] BENCHMARK COMPLETED!\n`);
    console.log(`======================================================================`);
    console.log(`                     PUSH VS PULL MODEL COMPARISON                    `);
    console.log(`======================================================================`);
    
    const tableData = [pullResult, pushResult].map(res => ({
      'Architecture Model': res.name,
      'Avg Latency (ms)': res.avgLatency + ' ms',
      'P99 Latency (ms)': res.p99Latency + ' ms',
      'Throughput (Reqs/Sec)': Math.round(res.rps) + ' reqs/s',
      'Data Bandwidth': res.throughput,
      'Total Requests Sent': res.totalRequests
    }));

    console.table(tableData);
    console.log(`======================================================================\n`);
  } catch (error) {
    console.error("Benchmark runner failed:", error.message);
    process.exit(1);
  }
}

main();
