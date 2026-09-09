const crypto = require('crypto');
const appleSignin = require('apple-signin-auth');
const Driver = require('../models/Driver');
const Kyc = require('../models/Kyc');
const Otp = require('../models/Otp');
const generateToken = require('../utils/generateToken');

/// Stamps a fresh session id on the driver and returns a token embedding
/// it — protect() rejects any older token once this rotates, so logging in
/// on a new device kicks out any other device's session. Callers that
/// already have an unsaved `driver` mutation pending (e.g. profile fields
/// just set) can skip the extra save by setting currentSessionId
/// themselves before their own save() and calling generateToken directly;
/// this helper is for the common case of "driver is otherwise unchanged,
/// just issue a session."
async function issueDriverSession(driver) {
  driver.currentSessionId = crypto.randomUUID();
  await driver.save();
  return generateToken(driver._id, driver.currentSessionId);
}
const { sendOtpViaMsg91, sendSignupEmailViaMsg91, sendForgotPasswordEmailViaMsg91 } = require('../utils/otpService');
const { OAuth2Client } = require('google-auth-library');
const audiences = process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.split(',').map(id => id.trim()).filter(id => id.length > 0) : [];
const client = new OAuth2Client(audiences[0]);

// @desc    Login or Signup with Google
// @route   POST /api/v1/auth/google
// @access  Public
exports.googleLoginOrSignup = async (req, res, next) => {
  try {
    const { idToken, mode } = req.body;

    if (!idToken) {
      res.status(400);
      throw new Error('Please provide a Google ID token');
    }

    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: audiences,
      });
    } catch (error) {
      // Decode the token without verification to see what's wrong (audience mismatch)
      const parts = idToken.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          console.error('[Google Auth] Verification Failed. Payload:', {
            aud: payload.aud,
            azp: payload.azp,
            email: payload.email,
            audiencesChecked: audiences
          });
        } catch (decodeError) {
          console.error('[Google Auth] Could not decode token:', decodeError.message);
        }
      }
      throw error;
    }

    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;

    // Find or create driver
    let driver = await Driver.findOne({ email });

    if (!driver) {
      if (mode === 'login') {
        // Login flow must not silently create an account — the user needs
        // to go through Sign Up explicitly.
        res.status(404);
        throw new Error('No account found for this Google account. Please sign up first.');
      }

      // Signup flow
      driver = await Driver.create({
        name,
        email,
        profilePicture: picture,
        isVerified: true, // Google accounts are implicitly verified for email
      });
    } else {
      // Only backfill profilePicture from Google when the driver doesn't have
      // one yet — never overwrite a photo the driver has since uploaded themselves.
      if (picture && !driver.profilePicture) {
        driver.profilePicture = picture;
        await driver.save();
      }
    }

    const token = await issueDriverSession(driver);

    res.status(200).json({
      _id: driver._id,
      driverId: driver.driverId,
      name: driver.name,
      email: driver.email,
      phone: driver.phone || null,
      profilePicture: driver.profilePicture,
      isVerified: driver.isVerified,
      token,
      needsPhone: !driver.phone // Tell frontend to prompt for phone if missing
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Login or Signup with Sign in with Apple
// @route   POST /api/v1/auth/apple
// @access  Public
exports.appleLoginOrSignup = async (req, res, next) => {
  try {
    const { identityToken, fullName, mode } = req.body;

    if (!identityToken) {
      res.status(400);
      throw new Error('Please provide an Apple identity token');
    }

    // Native iOS apps get the app's bundle ID as the token's audience (not
    // a Services ID — that's only for the web/JS flow, which this isn't).
    const payload = await appleSignin.verifyIdToken(identityToken, {
      audience: 'com.woglotech.driver',
      ignoreExpiration: false,
    });

    const appleId = payload.sub;
    // Apple discloses email only on the FIRST authorization for a given
    // Apple ID + app; returning sign-ins carry just `sub`, so appleId (not
    // email) is the durable key to match on.
    let driver = await Driver.findOne({ appleId });

    if (!driver && payload.email) {
      const emailNorm = payload.email.toLowerCase().trim();
      driver = await Driver.findOne({ email: emailNorm });
      if (driver) {
        // Existing account (e.g. signed up via Google/email) linking Apple
        // as a sign-in method for the first time.
        driver.appleId = appleId;
        await driver.save();
      }
    }

    if (!driver) {
      if (mode === 'login') {
        res.status(404);
        throw new Error('No account found for this Apple ID. Please sign up first.');
      }
      if (!payload.email) {
        // First-ever Apple auth for this ID with no email in the token, and
        // no account to fall back to — nothing usable to create one from.
        res.status(400);
        throw new Error('Could not get email from Apple. Please try again or use a different sign-up method.');
      }

      driver = await Driver.create({
        name: fullName || `User-${appleId.slice(-6)}`,
        email: payload.email.toLowerCase().trim(),
        appleId,
        isVerified: true, // Apple accounts are implicitly verified for email
      });
    }

    const token = await issueDriverSession(driver);

    res.status(200).json({
      _id: driver._id,
      driverId: driver.driverId,
      name: driver.name,
      email: driver.email,
      phone: driver.phone || null,
      profilePicture: driver.profilePicture,
      isVerified: driver.isVerified,
      token,
      needsPhone: !driver.phone
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Initiate Email Signup (Sends OTP)
// @route   POST /api/v1/auth/signup/email
// @access  Public
exports.signupEmail = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      res.status(400);
      throw new Error('Please provide name, email, and password');
    }

    // Check if driver exists with email
    const driverExists = await Driver.findOne({ email });
    if (driverExists) {
      res.status(400);
      throw new Error('Driver already exists with that email');
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save OTP to DB (Associate with email)
    await Otp.findOneAndUpdate(
      { email },
      { otp, createdAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );

    // Send OTP via Email
    await sendSignupEmailViaMsg91(email, otp);

    res.status(200).json({
      success: true,
      message: 'OTP sent to your email. Please verify to complete registration.',
      // In a real scenario, you might want to temporarily store user data or pass it back to frontend
      // For simplicity, we'll assume the frontend will send name, phone, password again during verification
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Verify Email OTP and Complete Signup
// @route   POST /api/v1/auth/verify-email-otp
// @access  Public
exports.verifyEmailOtp = async (req, res, next) => {
  try {
    const { name, email, password, otp } = req.body;

    if (!email || !otp || !name || !password) {
      res.status(400);
      throw new Error('Please provide all required fields including the OTP');
    }

    // Check OTP in DB
    const otpRecord = await Otp.findOne({ email, otp });

    if (!otpRecord) {
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    // OTP is valid, delete it
    await Otp.deleteOne({ _id: otpRecord._id });

    // Create Driver
    const sessionId = crypto.randomUUID();
    const driver = await Driver.create({
      name,
      email,
      password,
      currentSessionId: sessionId,
    });

    res.status(201).json({
      _id: driver._id,
      driverId: driver.driverId,
      name: driver.name,
      email: driver.email,
      phone: driver.phone,
      profilePicture: driver.profilePicture,
      token: generateToken(driver._id, sessionId),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Resend Email OTP
// @route   POST /api/v1/auth/resend-email-otp
// @access  Public
exports.resendEmailOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400);
      throw new Error('Please provide an email');
    }

    // Generate new 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save to DB
    await Otp.findOneAndUpdate(
      { email },
      { otp, createdAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );

    // Send via Email
    await sendSignupEmailViaMsg91(email, otp);

    res.status(200).json({
      success: true,
      message: 'OTP resent successfully to your email',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Auth driver & get token
// @route   POST /api/v1/auth/login/driver
// @access  Public
exports.loginDriver = async (req, res, next) => {
  try {
    const { identifier, email, phone, password } = req.body;

    // Accept 'identifier' (sent by Flutter app) OR explicit 'email'/'phone'
    const loginId = identifier || email || phone;

    if (!loginId || !password) {
      res.status(400);
      throw new Error('Please provide your email/phone and password');
    }

    // Auto-detect: if it contains @ it's an email, otherwise treat as phone
    let query;
    if (loginId.includes('@')) {
      query = { email: loginId.toLowerCase().trim() };
    } else {
      query = { phone: Driver.normalizePhone(loginId) };
    }

    const driver = await Driver.findOne(query);

    // driver.password is unset for accounts created via Google/phone-OTP
    // that never set a password — skip matchPassword() in that case rather
    // than letting bcrypt throw on a missing hash.
    if (driver && driver.password && (await driver.matchPassword(password))) {
      const token = await issueDriverSession(driver);
      res.json({
        _id: driver._id,
        driverId: driver.driverId,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        profilePicture: driver.profilePicture,
        isVerified: driver.isVerified,
        token,
      });
    } else {
      res.status(401);
      throw new Error('Invalid credentials');
    }
  } catch (error) {
    next(error);
  }
};

exports.refreshToken = async (req, res) => { res.json({ message: 'Refresh token endpoint' }); };
// @desc    Initiate Forgot Password (Sends OTP via Email)
// @route   POST /api/v1/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email, appType } = req.body;

    if (!email) {
      res.status(400);
      throw new Error('Please provide an email');
    }

    const driver = await Driver.findOne({ email });
    if (!driver) {
      res.status(404);
      throw new Error('No driver found with that email');
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save/Update OTP in DB
    await Otp.findOneAndUpdate(
      { email },
      { otp, createdAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );

    // Send OTP via Email (Passing appType to decide which template to use)
    await sendForgotPasswordEmailViaMsg91(email, otp, appType);

    res.status(200).json({
      success: true,
      message: 'Password reset OTP sent to your email',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reset Password using OTP
// @route   POST /api/v1/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      res.status(400);
      throw new Error('Please provide email, otp, and newPassword');
    }

    // Verify OTP
    const otpRecord = await Otp.findOne({ email, otp });

    if (!otpRecord) {
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    // Find Driver
    const driver = await Driver.findOne({ email });
    if (!driver) {
      res.status(404);
      throw new Error('Driver not found');
    }

    // Update Password (hashed via pre-save hook in Driver model)
    driver.password = newPassword;
    await driver.save();

    // Delete OTP
    await Otp.deleteOne({ _id: otpRecord._id });

    res.status(200).json({
      success: true,
      message: 'Password reset successful. You can now login with your new password.',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Initiate Phone Login/Signup via WhatsApp OTP
// @route   POST /api/v1/auth/phone-login
// @access  Public
exports.loginOrSignupPhone = async (req, res, next) => {
  try {
    const { phone: rawPhone } = req.body;
    const phone = Driver.normalizePhone(rawPhone);

    if (!phone) {
      res.status(400);
      throw new Error('Please provide a phone number');
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save to DB (override existing if any)
    await Otp.findOneAndUpdate(
      { phone },
      { otp, createdAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );

    // Send via WhatsApp
    await sendOtpViaMsg91(phone, otp);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to WhatsApp',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Verify OTP and Login/Signup
// @route   POST /api/v1/auth/verify-otp
// @access  Public
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone: rawPhone, otp, mode } = req.body;
    const phone = Driver.normalizePhone(rawPhone);

    if (!phone || !otp) {
      res.status(400);
      throw new Error('Please provide phone and otp');
    }

    // Check OTP in DB
    const otpRecord = await Otp.findOne({ phone, otp });

    if (!otpRecord) {
      res.status(400);
      throw new Error('Invalid or expired OTP');
    }

    // OTP is valid, delete it
    await Otp.deleteOne({ _id: otpRecord._id });

    // Find or Create Driver
    let driver = await Driver.findOne({ phone });

    if (!driver) {
      if (mode === 'login') {
        // Login flow must not silently create an account — the user needs
        // to go through Sign Up explicitly (mirrors googleLoginOrSignup).
        res.status(404);
        throw new Error('No account found for this phone number. Please sign up first.');
      }

      // Signup Flow (Minimal profile, can be completed later)
      driver = await Driver.create({
        phone,
        name: `User-${phone.slice(-4)}`, // Placeholder name
        isVerified: true
      });
    }

    const token = await issueDriverSession(driver);

    res.status(200).json({
      _id: driver._id,
      driverId: driver.driverId,
      name: driver.name,
      phone: driver.phone,
      profilePicture: driver.profilePicture,
      isVerified: driver.isVerified,
      token,
    });
  } catch (error) {
    next(error);
  }
};

exports.verifyEmail = async (req, res) => { res.json({ message: 'Verify email endpoint' }); };
// @desc    Complete driver registration (Link phone to account via OTP)
// @route   POST /api/v1/auth/complete-driver-registration
// @access  Private
exports.completeDriverRegistration = async (req, res, next) => {
  try {
    const { phone: rawPhone, otp } = req.body;
    const phone = Driver.normalizePhone(rawPhone);

    if (!phone || !otp) {
      res.status(400);
      throw new Error('Please provide phone and otp');
    }

    // Verify OTP first
    const otpRecord = await Otp.findOne({ phone, otp });
    if (!otpRecord) {
      res.status(400);
      throw new Error('Invalid or expired OTP for this phone');
    }

    // Check if another driver is already using this phone number
    const phoneTaken = await Driver.findOne({ phone, _id: { $ne: req.driver._id } });
    if (phoneTaken) {
      res.status(400);
      throw new Error('This phone number is already linked to another account');
    }

    // Link phone and update driver profile
    const driver = await Driver.findById(req.driver._id);
    if (!driver) {
      res.status(404);
      throw new Error('Driver not found');
    }

    driver.phone = phone;
    driver.isVerified = true;
    driver.currentSessionId = crypto.randomUUID();
    const updatedDriver = await driver.save();

    // Delete OTP record after successful linking
    await Otp.deleteOne({ _id: otpRecord._id });

    res.status(200).json({
      success: true,
      message: 'Phone number linked successfully',
      data: {
        _id: updatedDriver._id,
        driverId: updatedDriver.driverId,
        name: updatedDriver.name,
        email: updatedDriver.email,
        phone: updatedDriver.phone,
        isVerified: updatedDriver.isVerified,
        token: generateToken(updatedDriver._id, updatedDriver.currentSessionId),
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Complete profile right after phone signup — phone signup (see
// verifyOtp above) creates a minimal account with just a phone number and a
// placeholder name, with no email/password at all, so the driver could
// never log in via the email option. This sets real name/email/password on
// that same account so both login paths work afterward.
// @route   PUT /api/v1/auth/complete-profile
// @access  Private
exports.completeProfile = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      res.status(400);
      throw new Error('Please provide name, email, and password');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400);
      throw new Error('Please provide a valid email address');
    }
    if (password.length < 8) {
      res.status(400);
      throw new Error('Password must be at least 8 characters');
    }

    const emailTaken = await Driver.findOne({ email, _id: { $ne: req.driver._id } });
    if (emailTaken) {
      res.status(400);
      throw new Error('An account with this email already exists');
    }

    const driver = await Driver.findById(req.driver._id);
    if (!driver) {
      res.status(404);
      throw new Error('Driver not found');
    }

    driver.name = name;
    driver.email = email;
    driver.password = password; // pre-save hook hashes it
    await driver.save();

    res.status(200).json({
      success: true,
      message: 'Profile completed successfully',
      data: {
        _id: driver._id,
        driverId: driver.driverId,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        profilePicture: driver.profilePicture,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Set phone number on an account created via email signup (which
// has name/email/password but no phone at all — see verifyEmailOtp). Saved
// as entered, no OTP verification of the number itself — an explicit
// product decision to keep this a single-screen step rather than requiring
// another OTP round-trip.
// @route   PUT /api/v1/auth/complete-phone
// @access  Private
exports.completePhone = async (req, res, next) => {
  try {
    const phone = Driver.normalizePhone(req.body.phone);

    if (!phone || phone.length !== 12) {
      res.status(400);
      throw new Error('Please provide a valid 10-digit phone number');
    }

    const phoneTaken = await Driver.findOne({ phone, _id: { $ne: req.driver._id } });
    if (phoneTaken) {
      res.status(400);
      throw new Error('This phone number is already linked to another account');
    }

    const driver = await Driver.findById(req.driver._id);
    if (!driver) {
      res.status(404);
      throw new Error('Driver not found');
    }

    driver.phone = phone;
    await driver.save();

    res.status(200).json({
      success: true,
      message: 'Phone number saved successfully',
      data: {
        _id: driver._id,
        driverId: driver.driverId,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        profilePicture: driver.profilePicture,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Upload KYC document
// @route   POST /api/v1/auth/upload-driver-kyc
// @access  Private
exports.uploadDriverKyc = async (req, res, next) => {
  try {
    const { type } = req.body;

    if (!req.files || !req.files['documentFileFront']) {
      res.status(400);
      throw new Error('Please upload at least the front side of the document');
    }

    if (!type) {
      res.status(400);
      throw new Error('Please provide the KYC document type');
    }

    // Map to valid KYC types defined in model
    const validTypes = ['Driving License', 'Aadhar Card', 'PAN Card', 'Passport'];
    if (!validTypes.includes(type)) {
      res.status(400);
      throw new Error(`Invalid KYC type. Must be one of: ${validTypes.join(', ')}`);
    }

    // Extract file buffers from memory storage and convert to Base64 data URIs
    const frontFile = req.files['documentFileFront'][0];
    const fileUrlFront = `data:${frontFile.mimetype};base64,${frontFile.buffer.toString('base64')}`;

    let fileUrlBack = undefined;
    if (req.files['documentFileBack']) {
      const backFile = req.files['documentFileBack'][0];
      fileUrlBack = `data:${backFile.mimetype};base64,${backFile.buffer.toString('base64')}`;
    }

    // Check if this document type already exists for the driver, if so update it, else create new
    let kyc = await Kyc.findOne({ driver: req.driver._id, type });
    
    if (kyc) {
      kyc.fileUrlFront = fileUrlFront;
      if (fileUrlBack) kyc.fileUrlBack = fileUrlBack;
      kyc.status = 'pending'; // Requires admin approval
      await kyc.save();
    } else {
      kyc = await Kyc.create({
        driver: req.driver._id,
        type,
        fileUrlFront,
        fileUrlBack,
        status: 'pending',
      });
    }
    res.status(201).json({
      success: true,
      message: 'KYC Document uploaded successfully',
      data: kyc,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Change password
 * @route   PUT /api/v1/auth/change-password
 * @access  Private
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400);
      throw new Error('Please provide current and new passwords');
    }

    const driver = await Driver.findById(req.driver._id);

    if (!driver) {
      res.status(404);
      throw new Error('Driver not found');
    }

    // Verify current password
    const isMatch = await driver.matchPassword(currentPassword);
    if (!isMatch) {
      res.status(401);
      throw new Error('Invalid current password');
    }

    // Update password (pre-save hook will hash it)
    driver.password = newPassword;
    await driver.save();

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete driver KYC document
 * @route   DELETE /api/v1/auth/delete-driver-kyc/:id
 * @access  Private
 */
exports.deleteDriverKyc = async (req, res, next) => {
  try {
    const kyc = await Kyc.findById(req.params.id);

    if (!kyc) {
      res.status(404);
      throw new Error('Document not found');
    }

    // Check ownership
    if (kyc.driver.toString() !== req.driver._id.toString()) {
      res.status(401);
      throw new Error('Not authorized to delete this document');
    }

    await Kyc.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
