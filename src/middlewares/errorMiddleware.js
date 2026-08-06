const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

const errorHandler = (err, req, res, next) => {
  let statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  let message = err.message;

  // Mongo duplicate-key error — happens when two requests race past a
  // findOne-then-create check (e.g. double-tapping "Verify OTP", or a
  // driverId collision on signup). The record was never actually
  // duplicated (the unique index rejected the second insert), but without
  // this the raw Mongo error leaks to the client as a 500. Surface a clean,
  // actionable message instead.
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    if (field === 'email') {
      message = 'An account with this email already exists. Please log in instead.';
    } else if (field === 'phone') {
      message = 'An account with this phone number already exists. Please log in instead.';
    } else if (field === 'driverId') {
      message = 'Could not generate a unique driver ID, please try again.';
    } else {
      message = 'This value is already in use.';
    }
  }

  res.status(statusCode).json({
    message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

module.exports = { notFound, errorHandler };
