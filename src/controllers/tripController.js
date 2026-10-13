/**
 * Legacy demo/itinerary Trip system — predates real bookings and is NOT
 * where live ride/booking actions live; that's driverBookingController.js
 * (/api/v1/driver-bookings), which proxies the customer backend. This one
 * is still genuinely read by the Flutter app though, not dead code:
 * calendar_page.dart and driver_rating_service.dart both call
 * TripService.loadTrips() (GET /api/v1/trips) for calendar display and
 * rating/review data pulled from this Trip model's own review subdocs.
 * Don't delete it without replacing those two call sites first, and don't
 * add real-booking logic here — add it to driverBookingController.js.
 */
const Trip = require('../models/Trip');

// @desc    Get all trips for a driver
// @route   GET /api/v1/trips
// @access  Private
exports.getTrips = async (req, res, next) => {
  try {
    const trips = await Trip.find({ driver: req.driver._id }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: trips.length,
      data: trips
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single trip details
// @route   GET /api/v1/trips/:id
// @access  Private
exports.getTrip = async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      res.status(404);
      throw new Error(`Trip not found with id of ${req.params.id}`);
    }

    // Check if the trip belongs to the driver
    if (trip.driver.toString() !== req.driver._id.toString()) {
      res.status(403);
      throw new Error('Not authorized to access this trip');
    }

    res.status(200).json({
      success: true,
      data: trip
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add review to trip (for demo/vendor purposes)
// @route   POST /api/v1/trips/:id/review
// @access  Private (Simplified)
exports.addReview = async (req, res, next) => {
  try {
    const { customerName, rating, comment } = req.body;

    if (!customerName || !rating) {
      res.status(400);
      throw new Error('Please provide customerName and rating');
    }

    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      res.status(404);
      throw new Error(`Trip not found with id of ${req.params.id}`);
    }

    trip.reviews.push({
      customerName,
      rating: Number(rating),
      comment
    });

    await trip.save();

    res.status(200).json({
      success: true,
      message: 'Review added successfully',
      data: trip
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update trip status (e.g., start/complete trip)
// @route   PUT /api/v1/trips/:id/status
// @access  Private
exports.updateTripStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const trip = await Trip.findById(req.params.id);

    if (!trip) {
      res.status(404);
      throw new Error(`Trip not found with id of ${req.params.id}`);
    }

    if (trip.driver.toString() !== req.driver._id.toString()) {
      res.status(403);
      throw new Error('Not authorized to access this trip');
    }

    trip.status = status;
    await trip.save();

    res.status(200).json({
      success: true,
      message: 'Trip status updated successfully',
      data: trip
    });
  } catch (error) {
    next(error);
  }
};
