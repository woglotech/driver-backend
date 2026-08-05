const jwt = require('jsonwebtoken');

// `sessionId` is optional — admin tokens (adminController.js) don't pass
// one and are unaffected. Driver tokens pass the driver's current
// currentSessionId so protect() can reject any older token once a newer
// login has rotated it (single-device enforcement).
const generateToken = (id, sessionId) => {
  return jwt.sign(
    sessionId ? { id, sid: sessionId } : { id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '30d' }
  );
};

module.exports = generateToken;
