// Creates (or updates the password of) an admin account for the driver admin panel.
// Usage: node seedAdmin.js <email> <password> [name]
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./src/models/Admin');

async function run() {
  const [, , email, password, name] = process.argv;

  if (!email || !password) {
    console.error('Usage: node seedAdmin.js <email> <password> [name]');
    process.exit(1);
  }

  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error('MONGO_URI is missing from environment variables');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);

  let admin = await Admin.findOne({ email: email.toLowerCase().trim() });
  if (admin) {
    admin.password = password; // pre-save hook re-hashes since it's modified
    admin.name = name || admin.name;
    await admin.save();
    console.log(`Updated password for existing admin: ${admin.email}`);
  } else {
    admin = await Admin.create({ email, password, name: name || 'Admin' });
    console.log(`Created new admin: ${admin.email}`);
  }

  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('Failed to seed admin:', err.message);
  process.exit(1);
});
