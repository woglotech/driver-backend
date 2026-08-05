const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const driverSchema = new mongoose.Schema({
  driverId: { type: String, unique: true }, // Custom readable ID like WOG-1234
  name: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true, sparse: true },
  password: { type: String },
  dob: { type: Date },
  address: {
    line1: { type: String },
    city: { type: String },
    state: { type: String },
    country: { type: String },
    pinCode: { type: String }
  },
  license: {
    number: { type: String },
    validTill: { type: String },
    types: [{ type: String }]
  },
  documents: {
    aadharNumber: { type: String },
    panCardNumber: { type: String }
  },
  bankDetails: {
    accountHolderName: { type: String },
    bankName: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    branchName: { type: String },
    accountType: { type: String }
  },
  profilePicture: { type: String },
  languages: [{ type: String }],
  rating: { type: Number, default: 0 },
  isVerified: { type: Boolean, default: false },
  kycStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  kycRejectionReason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  // Stamped fresh on every login/token-issuing action; embedded in the JWT
  // as `sid`. protect() rejects any token whose sid doesn't match this
  // current value, so logging in on a new device invalidates every other
  // device's session — enforces single-device login without needing a
  // server-side token blocklist.
  currentSessionId: { type: String },
}, { timestamps: true });

// Helper to normalize phone numbers to 91xxxxxxxxxx format
driverSchema.statics.normalizePhone = function(phone) {
  if (!phone) return null;
  let cleanPhone = String(phone).replace(/\D/g, "");
  if (cleanPhone.length === 10) {
    cleanPhone = "91" + cleanPhone;
  }
  return cleanPhone;
};

// Pre-save hook to hash password and generate driverId if new
driverSchema.pre('save', async function() {
  // Normalize phone if modified
  if (this.isModified('phone') && this.phone) {
    this.phone = mongoose.model('Driver').normalizePhone(this.phone);
  }

  // Generate Custom User ID if it doesn't exist
  if (!this.driverId) {
    const randomNum = Math.floor(10000 + Math.random() * 90000); // 5 digit random number
    this.driverId = `WOG-DRV-${randomNum}`;
  }

  // Hash password only if modified
  if (!this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to verify password match
driverSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('Driver', driverSchema);
