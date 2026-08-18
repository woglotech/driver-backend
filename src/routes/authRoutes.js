const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const { uploadKyc } = require('../config/multerConfig');

router.post('/signup/email', authController.signupEmail);
router.post('/google', authController.googleLoginOrSignup);
router.post('/verify-email-otp', authController.verifyEmailOtp);
router.post('/resend-email-otp', authController.resendEmailOtp);
router.post('/login/driver', authController.loginDriver);
router.post('/phone-login', authController.loginOrSignupPhone);
router.post('/verify-otp', authController.verifyOtp);
router.post('/refresh-token', authController.refreshToken);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/verify-email', authController.verifyEmail);
router.post('/complete-driver-registration', protect, authController.completeDriverRegistration);
router.put('/complete-profile', protect, authController.completeProfile);
router.put('/complete-phone', protect, authController.completePhone);
router.post('/upload-driver-kyc', protect, uploadKyc.fields([{ name: 'documentFileFront', maxCount: 1 }, { name: 'documentFileBack', maxCount: 1 }]), authController.uploadDriverKyc);
router.delete('/delete-driver-kyc/:id', protect, authController.deleteDriverKyc);
router.put('/change-password', protect, authController.changePassword);

module.exports = router;
