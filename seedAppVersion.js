require('dotenv').config();
const mongoose = require('mongoose');
const AppVersion = require('./src/models/AppVersion');

// Seeds an initial, non-blocking config for the currently-shipped build
// (pubspec.yaml version: 1.0.1) so the version-check endpoint has data to
// serve immediately. minSupportedVersion == latestVersion here on purpose:
// nobody is forced to update yet. Bump minSupportedVersion via the admin
// endpoint (PUT /api/v1/admin/app-version/android) whenever a release
// should become mandatory.
const seedDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB for seeding...');

    const config = await AppVersion.findOneAndUpdate(
      { platform: 'android' },
      {
        platform: 'android',
        latestVersion: '1.0.1',
        minSupportedVersion: '1.0.1',
        updateMessage: 'A new version of the Woglo Driver app is available. Please update to continue.',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.woglo.driver',
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    console.log('Seeded app version config:', config);
    process.exit(0);
  } catch (err) {
    console.error('Error seeding app version config:', err);
    process.exit(1);
  }
};

seedDB();
