const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', required: true },
  type: { 
    type: String, 
    enum: ['Driving License', 'Aadhar Card', 'PAN Card', 'Passport'], 
    required: true 
  },
  fileUrlFront: { type: String, required: true },
  fileUrlBack: { type: String }, // Optional, not all docs have back side
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  rejectionReason: { type: String, default: '' },
  uploadedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Every admin driver-list request counts KYC docs per driver ($group by
// driver); without this it scans the whole (base64-heavy) collection each time.
kycSchema.index({ driver: 1 });

module.exports = mongoose.model('Kyc', kycSchema);
