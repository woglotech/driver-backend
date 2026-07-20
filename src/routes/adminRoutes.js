const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protectAdmin } = require('../middlewares/adminMiddleware');

// Public
router.post('/login', adminController.login);

// Drivers / KYC
router.get('/drivers', protectAdmin, adminController.listDrivers);
router.get('/drivers/:driverId', protectAdmin, adminController.getDriver);
router.put('/drivers/:driverId/approve', protectAdmin, adminController.approveDriver);
router.put('/drivers/:driverId/kyc/:kycId', protectAdmin, adminController.updateKycDocStatus);

module.exports = router;
