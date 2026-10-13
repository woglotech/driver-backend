const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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

const REFRESH_TOKEN_EXPIRE_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRE_DAYS, 10) || 90;

// Opaque random credential (not a JWT) stored on the driver doc and
// exchanged at POST /auth/refresh-token for a fresh access token — kept
// separate from the access token's own ~30d expiry so a driver who opens
// the app after a long gap gets silently re-authenticated instead of
// logged out. Returns the token string plus its expiry for the caller to
// persist on the driver.
const generateRefreshToken = () => ({
  refreshToken: crypto.randomBytes(48).toString('hex'),
  refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60 * 1000),
});

module.exports = generateToken;
module.exports.generateRefreshToken = generateRefreshToken;
