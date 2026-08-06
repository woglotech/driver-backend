/**
 * User Backend Bridge (Driver Backend)
 *
 * Proxies real booking data from the customer-facing backend
 * (woglo_user_app_backend) into the driver app — that backend's driver
 * webhooks are guarded by a bare shared secret (protectDriverKey), which
 * must never be embedded in a distributed mobile app, so the driver app
 * talks to ITS OWN backend (driver JWT) and this module makes the
 * server-to-server call on its behalf. Mirrors the exact same pattern
 * F:\woglo-backend's vendorDriverBridgeController.js already uses to call
 * this driver backend from the vendor side.
 */
const axios = require('axios');

const USER_BACKEND_URL = process.env.USER_BACKEND_URL;
const DRIVER_USER_API_KEY = process.env.DRIVER_USER_API_KEY;

function headers() {
  return {
    'x-vendor-api-key': DRIVER_USER_API_KEY,
    'Content-Type': 'application/json',
  };
}

function assertConfigured() {
  if (!USER_BACKEND_URL || !DRIVER_USER_API_KEY) {
    const err = new Error('User backend bridge is not configured (missing USER_BACKEND_URL/DRIVER_USER_API_KEY)');
    err.status = 500;
    throw err;
  }
}

async function fetchDriverBookings(driverId, status) {
  assertConfigured();
  const url = `${USER_BACKEND_URL}/api/v1/bookings/driver/${driverId}${status ? `?status=${encodeURIComponent(status)}` : ''}`;
  const response = await axios.get(url, { headers: headers(), timeout: 10000 });
  return response.data?.data || [];
}

async function fetchBookingDriverView(bookingId) {
  assertConfigured();
  const response = await axios.get(
    `${USER_BACKEND_URL}/api/v1/bookings/${bookingId}/driver-view`,
    { headers: headers(), timeout: 10000 }
  );
  return response.data?.data || null;
}

async function startTrip(bookingId, startOdometerKm) {
  assertConfigured();
  const response = await axios.post(
    `${USER_BACKEND_URL}/api/v1/bookings/${bookingId}/start`,
    { startOdometerKm },
    { headers: headers(), timeout: 10000 }
  );
  return response.data?.data || null;
}

async function pickupDone(bookingId) {
  assertConfigured();
  const response = await axios.post(
    `${USER_BACKEND_URL}/api/v1/bookings/${bookingId}/pickup-done`,
    {},
    { headers: headers(), timeout: 10000 }
  );
  return response.data?.data || null;
}

async function completeTrip(bookingId, endOdometerKm) {
  assertConfigured();
  const response = await axios.post(
    `${USER_BACKEND_URL}/api/v1/bookings/${bookingId}/complete`,
    { endOdometerKm },
    { headers: headers(), timeout: 10000 }
  );
  return response.data?.data || null;
}

async function updateLocation(bookingId, lat, lng) {
  assertConfigured();
  const response = await axios.patch(
    `${USER_BACKEND_URL}/api/v1/bookings/${bookingId}/location`,
    { lat, lng },
    { headers: headers(), timeout: 10000 }
  );
  return response.data?.data || null;
}

module.exports = {
  fetchDriverBookings,
  fetchBookingDriverView,
  startTrip,
  pickupDone,
  completeTrip,
  updateLocation,
};
