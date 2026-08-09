const express = require('express');
const db = require('./db');
const config = require('./config');

const app = express();

// Import Routers
const seedRouter = require('./routes/seed');
const feedRouter = require('./routes/feed');
const authMiddleware = require('./middleware/auth');

// Mount Auth Guard Globally
app.use(authMiddleware);

// Mount Routers
app.use(seedRouter);
app.use('/feed', feedRouter);

// Setup DB Tables and Indexes
async function initDb() {
  console.log("Initializing database tables...");
  
  if (db.isPostgres) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS follows (
        follower_id INT,
        followee_id INT,
        PRIMARY KEY (follower_id, followee_id)
      );
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS tweets (
        id SERIAL PRIMARY KEY,
        user_id INT,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    await db.run(`
      CREATE TABLE IF NOT EXISTS follows (
        follower_id INTEGER,
        followee_id INTEGER,
        PRIMARY KEY (follower_id, followee_id)
      );
    `);
    await db.run(`
      CREATE TABLE IF NOT EXISTS tweets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // Create Indexes for SQL performance
  try {
    await db.run("CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);");
    await db.run("CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);");
    await db.run("CREATE INDEX IF NOT EXISTS idx_tweets_user_time ON tweets(user_id, created_at DESC);");
    console.log("Database initialized with indexes.");
  } catch (err) {
    console.warn("Index creation warning (might already exist):", err.message);
  }
}

// Start server and initialize tables
initDb().then(() => {
  app.listen(config.port, () => {
    console.log(`System design benchmark API listening at http://localhost:${config.port}`);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
