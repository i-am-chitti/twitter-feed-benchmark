require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  apiKey: process.env.API_KEY || 'local-dev-key',
  celebThreshold: 500, // Users with >= 500 followers are celebrities
  userCount: 1000, // Number of simulated active users
  celebrityIds: [1, 2, 3] // Explicit celebrity account IDs
};
