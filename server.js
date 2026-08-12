const express = require('express');
const config = require('./config');
const schema = require('./schema');

const app = express();

const seedRouter = require('./routes/seed');
const feedRouter = require('./routes/feed');
const authMiddleware = require('./middleware/auth');

app.use(authMiddleware);
app.use(seedRouter);
app.use('/feed', feedRouter);

schema
  .ensureSchema()
  .then(() => {
    app.listen(config.port, () =>
      console.log(`benchmark api listening on http://localhost:${config.port}`)
    );
  })
  .catch((err) => {
    console.error('schema init failed:', err);
    process.exit(1);
  });
