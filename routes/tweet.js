const express = require('express');
const router = express.Router();
const { publishTweet } = require('../lib/fanout');

// Body: { userId, content?, forceFanout? }
router.post('/tweet', async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'userId must be a positive integer' });
  }

  try {
    const result = await publishTweet({
      userId,
      content: req.body?.content ?? `Tweet from ${userId}`,
      forceFanout: req.body?.forceFanout === true,
    });
    res.set(
      'Server-Timing',
      Object.entries(result.timings)
        .map(([k, v]) => `${k};dur=${v.toFixed(2)}`)
        .join(', ')
    );
    res.status(201).json(result);
  } catch (err) {
    console.error('[tweet]', err);
    res.status(500).json({ error: 'publish_failed', detail: err.message });
  }
});

module.exports = router;
