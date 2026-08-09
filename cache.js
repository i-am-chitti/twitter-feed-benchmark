const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.redisUrl);

redis.on('connect', () => {
  console.log('Connected to Redis cache successfully.');
});

redis.on('error', (err) => {
  console.error('Redis cache connection error:', err);
});

module.exports = redis;
