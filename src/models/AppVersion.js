const mongoose = require('mongoose');

// One document per platform. Admin updates this after each Play Store /
// App Store release; the app calls GET /api/v1/app/version-check on every
// launch to decide whether to block usage until the user updates.
const appVersionSchema = new mongoose.Schema({
  platform: { type: String, enum: ['android', 'ios'], required: true, unique: true },
  latestVersion: { type: String, required: true },
  // Any installed version below this is forced to update before it can
  // keep using the app. Leave equal to latestVersion to force every update,
  // or lower than it to make the current release optional.
  minSupportedVersion: { type: String, required: true },
  updateMessage: {
    type: String,
    default: 'A new version of the app is available. Please update to continue.',
  },
  storeUrl: { type: String, required: true },
}, { timestamps: true });

module.exports = mongoose.model('AppVersion', appVersionSchema);
