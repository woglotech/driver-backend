const jwt = require('jsonwebtoken');
const Driver = require('../models/Driver');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      // Decode token id
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Find driver by decoded id excluding password
      req.driver = await Driver.findById(decoded.id).select('-password');

      if (!req.driver) {
        return res.status(401).json({ message: 'Not authorized, driver not found' });
      }

      // Single-device enforcement: only rejects once a currentSessionId has
      // actually been stamped (i.e. after this driver's first login post-
      // rollout) — an old pre-existing token with no `sid` still works
      // until the driver logs in again, so this doesn't mass-logout every
      // active session the moment it deploys. Once any login happens, only
      // the token from that most recent login keeps matching.
      if (req.driver.currentSessionId && decoded.sid !== req.driver.currentSessionId) {
        return res.status(401).json({
          message: 'You have been logged out because this account was signed in on another device.',
        });
      }

      next();
    } catch (error) {
      console.error(error);
      res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    res.status(401).json({ message: 'Not authorized, no token' });
  }
};

module.exports = { protect };
