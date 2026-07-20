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

module.exports = mongoose.model('Kyc', kycSchema);
