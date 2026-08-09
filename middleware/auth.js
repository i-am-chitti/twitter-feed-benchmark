const config = require('../config');

function authMiddleware(req, res, next) {
  // Skip authentication if no API key is configured (e.g. local dev)
  if (!config.apiKey) {
    return next();
  }

  const incomingApiKey = req.headers['x-api-key'] || req.query.apiKey;

  if (!incomingApiKey || incomingApiKey !== config.apiKey) {
    return res.status(401).json({
      error: 'Unauthorized: Missing or invalid x-api-key header or apiKey query parameter.'
    });
  }

  next();
}

module.exports = authMiddleware;
