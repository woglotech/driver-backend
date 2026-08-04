const express = require('express');
const router = express.Router();
const driverBookingController = require('../controllers/driverBookingController');
const { protect } = require('../middlewares/authMiddleware');

// Deliberately a separate route group from /api/v1/trips, which stays the
// pre-existing, unrelated itinerary/demo Trip system — this one is backed
// by real bookings via userBackendBridge.js.
router.use(protect);

router.get('/', driverBookingController.getMyBookings);
router.get('/:id', driverBookingController.getBookingDetail);
router.post('/:id/start', driverBookingController.startTrip);
router.post('/:id/complete', driverBookingController.completeTrip);
router.patch('/:id/location', driverBookingController.updateLocation);

module.exports = router;
