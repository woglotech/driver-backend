/**
 * Real, booking-backed trips for the driver app — proxies to the customer
 * backend via userBackendBridge.js. Every mutating action (start/complete/
 * location) fetches the booking first and verifies it's actually assigned
 * to the calling driver before forwarding anything — the customer
 * backend's own webhooks only check a shared secret, not driver identity,
 * so that check belongs here.
 */
const bridge = require('../services/userBackendBridge');

async function assertOwnsBooking(bookingId, driverId) {
  const booking = await bridge.fetchBookingDriverView(bookingId);
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  const assignedId = booking.assignedDriverId?._id || booking.assignedDriverId;
  if (!assignedId || assignedId.toString() !== driverId.toString()) {
    const err = new Error('This trip is not assigned to you');
    err.status = 403;
    throw err;
  }
  return booking;
}

exports.getMyBookings = async (req, res, next) => {
  try {
    const bookings = await bridge.fetchDriverBookings(req.driver._id, req.query.status);
    res.json({ success: true, data: bookings });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.getBookingDetail = async (req, res, next) => {
  try {
    const booking = await assertOwnsBooking(req.params.id, req.driver._id);
    res.json({ success: true, data: booking });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.startTrip = async (req, res, next) => {
  try {
    await assertOwnsBooking(req.params.id, req.driver._id);
    const { startOdometerKm } = req.body;
    const updated = await bridge.startTrip(req.params.id, startOdometerKm);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(error.status || error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message,
    });
  }
};

exports.completeTrip = async (req, res, next) => {
  try {
    await assertOwnsBooking(req.params.id, req.driver._id);
    const { endOdometerKm } = req.body;
    const updated = await bridge.completeTrip(req.params.id, endOdometerKm);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(error.status || error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message,
    });
  }
};

exports.updateLocation = async (req, res, next) => {
  try {
    await assertOwnsBooking(req.params.id, req.driver._id);
    const { lat, lng } = req.body;
    const updated = await bridge.updateLocation(req.params.id, lat, lng);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(error.status || error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || error.message,
    });
  }
};
