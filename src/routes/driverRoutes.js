const express = require('express');
const router = express.Router();

const driverController = require('../controllers/driverController');
const { protect } = require('../middlewares/authMiddleware');
const { uploadProfile } = require('../config/multerConfig');

// Public — served via <img>/Image.network from list views (vendor browse,
// admin panel), which don't send an auth header. Registered before the
// protect() gate below so it's exempt from it.
router.get('/:id/photo', driverController.getDriverPhoto);

router.use(protect); // Protect all routes in this file

router.get('/dashboard', driverController.getDashboard);
router.get('/profile', driverController.getProfile);
router.post('/profile-picture', uploadProfile.single('profileImage'), driverController.uploadProfilePicture);
router.route('/account/profile')
  .get(driverController.getProfile)
  .put(driverController.updateAccountProfile);
router.delete('/account', driverController.deleteAccount);
router.get('/my-vehicles', driverController.getMyVehicles);
router.delete('/my-vehicles/:id', driverController.deleteVehicle);
router.get('/documents', driverController.getDocuments);

router.get('/requests', driverController.getRequests);
router.get('/requests/pending', driverController.getPendingRequests);
router.put('/requests/:id/status', driverController.updateRideStatus);

router.get('/vendor-requests', driverController.getVendorRequests);
router.put('/vendor-requests/:id/respond', driverController.respondToVendorRequest);
router.delete('/vendor-requests/:id', driverController.deleteVendorRequest);
router.post('/vendor-requests/mock-send', driverController.mockCreateVendorRequest);

router.get('/inbox', driverController.getInbox);
router.post('/inbox/send-message', driverController.sendInboxMessage);

router.get('/help/support-info', driverController.getSupportInfo);
router.get('/help/support-types', driverController.getSupportTypes);

router.get('/calendar/current', driverController.getCurrentCalendar);
router.get('/calendar', driverController.getCalendar);
router.get('/calendar/availability', driverController.getCalendarAvailability);
router.post('/calendar/update-status', driverController.updateCalendarStatus);

router.get('/notifications', driverController.getNotifications);
router.get('/notifications/unread-count', driverController.getUnreadNotificationCount);
router.put('/notifications/mark-all-read', driverController.markAllNotificationsRead);

router.get('/past-rides', driverController.getPastRides);

module.exports = router;
