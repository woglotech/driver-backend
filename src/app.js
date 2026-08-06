const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// `cors` only reflects an Origin it finds as an exact match in an array,
// so a literal ['*'] combined with credentials:true silently sends no
// Access-Control-Allow-Origin header at all (spec forbids literal '*' with
// credentials). `origin: true` reflects whatever Origin was sent, which is
// the correct way to allow any origin while still supporting credentials.
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true;
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(morgan('dev'));

// Static folder configuration for uploads
app.use('/uploads', express.static('uploads'));

// Health Route
app.get('/', (req, res) => {
  res.send('Woglo Driver API is running');
});

// Import Routes
const authRoutes = require('./routes/authRoutes');
const driverRoutes = require('./routes/driverRoutes');
const tripRoutes = require('./routes/tripRoutes');
const vendorBridgeRoutes = require('./routes/vendorBridgeRoutes');
const adminRoutes = require('./routes/adminRoutes');
const driverBookingRoutes = require('./routes/driverBookingRoutes');
const appVersionRoutes = require('./routes/appVersionRoutes');

// Mount Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/driver', driverRoutes);
app.use('/api/v1/trips', tripRoutes);
app.use('/api/v1/vendor', vendorBridgeRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/app', appVersionRoutes);
// Real, booking-backed trips (separate from /api/v1/trips, the unrelated
// pre-existing itinerary/demo Trip system).
app.use('/api/v1/driver-bookings', driverBookingRoutes);

const { notFound, errorHandler } = require('./middlewares/errorMiddleware');

// Error Handling Middleware
app.use(notFound);
app.use(errorHandler);

module.exports = app;
