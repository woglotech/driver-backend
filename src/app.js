const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const app = express();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];
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

// Admin panel (static SPA)
app.use('/admin', express.static(path.join(__dirname, '../admin-panel')));

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

// Mount Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/driver', driverRoutes);
app.use('/api/v1/trips', tripRoutes);
app.use('/api/v1/vendor', vendorBridgeRoutes);
app.use('/api/v1/admin', adminRoutes);

const { notFound, errorHandler } = require('./middlewares/errorMiddleware');

// Error Handling Middleware
app.use(notFound);
app.use(errorHandler);

module.exports = app;
