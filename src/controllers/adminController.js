const Admin = require('../models/Admin');
const Driver = require('../models/Driver');
const Kyc = require('../models/Kyc');
const Notification = require('../models/Notification');
const generateToken = require('../utils/generateToken');

const REQUIRED_DOC_TYPES = ['Driving License', 'Aadhar Card', 'PAN Card'];
const STATUS_VALUES = ['pending', 'approved', 'rejected'];

// ── Notification helper (non-blocking) ────────────────────────────────────
async function notifyDriver(driverId, title, message, type) {
  try {
    await Notification.create({ driver: driverId, title, message, type });
  } catch (err) {
    console.error('Failed to create notification:', err.message);
  }
}

// ── Recompute a driver's overall kycStatus from their Kyc documents ───────
// Overall status is 'approved' only once all mandatory doc types are each
// 'approved'; 'rejected' if any uploaded doc is 'rejected'; else 'pending'.
async function recomputeDriverKycStatus(driverId) {
  const docs = await Kyc.find({ driver: driverId }).sort({ uploadedAt: 1 });

  const latestByType = {};
  docs.forEach((d) => { latestByType[d.type] = d; }); // later entries overwrite earlier ones

  const hasRejected = docs.some((d) => d.status === 'rejected');
  const allRequiredApproved = REQUIRED_DOC_TYPES.every(
    (t) => latestByType[t] && latestByType[t].status === 'approved'
  );

  let newStatus = 'pending';
  if (hasRejected) newStatus = 'rejected';
  else if (allRequiredApproved) newStatus = 'approved';

  let rejectionReason = '';
  if (newStatus === 'rejected') {
    rejectionReason = docs
      .filter((d) => d.status === 'rejected')
      .map((d) => (d.rejectionReason ? `${d.type}: ${d.rejectionReason}` : d.type))
      .join('; ');
  }

  const driver = await Driver.findById(driverId);
  if (!driver) return null;

  const previousStatus = driver.kycStatus;
  driver.kycStatus = newStatus;
  driver.kycRejectionReason = rejectionReason;
  await driver.save();

  if (newStatus !== previousStatus) {
    if (newStatus === 'approved') {
      await notifyDriver(
        driverId,
        '🎉 KYC Verified Successfully',
        'Your KYC documents have been reviewed and approved. You are now a fully verified Woglo driver!',
        'kycApproved'
      );
    } else if (newStatus === 'rejected') {
      await notifyDriver(
        driverId,
        '❌ KYC Verification Rejected',
        rejectionReason
          ? `Your KYC was rejected: ${rejectionReason}. Please update your documents and resubmit.`
          : 'Your KYC was rejected. Please update your documents and resubmit.',
        'kycRejected'
      );
    }
  }

  return driver;
}

// ─── Admin login ──────────────────────────────────────────────────────────
// POST /api/v1/admin/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin || !(await admin.matchPassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({
      success: true,
      token: generateToken(admin._id),
      admin: { id: admin._id, name: admin.name, email: admin.email }
    });
  } catch (err) {
    console.error('admin login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── List drivers (filter by ?kycStatus=pending|approved|rejected) ───────
// GET /api/v1/admin/drivers
// Ordered by how many KYC documents the driver has uploaded (most first),
// then most recently updated — so drivers who actually submitted paperwork
// are reviewed before the ones who signed up and never uploaded anything.
// ?countOnly=1 returns just { total } (used by the stat cards).
exports.listDrivers = async (req, res) => {
  try {
    const { kycStatus, page = 1, limit = 20, search, countOnly } = req.query;

    const filter = {};
    if (kycStatus) {
      if (!STATUS_VALUES.includes(kycStatus)) {
        return res.status(400).json({ error: 'Invalid kycStatus filter. Must be pending, approved, or rejected' });
      }
      filter.kycStatus = kycStatus;
    }
    if (search) {
      // Escaped: an unescaped "(" or "[" used to throw and 500 the whole list.
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: re }, { email: re }, { phone: re }, { driverId: re }];
    }

    if (countOnly) {
      return res.json({ success: true, total: await Driver.countDocuments(filter) });
    }

    const skip = (Number(page) - 1) * Number(limit);

    // Document counts live in a separate Kyc collection, so a page-limited
    // Driver query can't be sorted by them directly. Rank instead: fetch just
    // {_id, updatedAt} for every matching driver (tiny rows), sort those by
    // (docCount desc, updatedAt desc), slice out this page, and only then
    // load the page's full driver documents.
    const [matching, docCounts] = await Promise.all([
      Driver.find(filter).select('_id updatedAt').lean(),
      Kyc.aggregate([{ $group: { _id: '$driver', count: { $sum: 1 } } }]),
    ]);
    const countByDriver = {};
    docCounts.forEach((c) => { countByDriver[String(c._id)] = c.count; });

    matching.sort((a, b) =>
      (countByDriver[String(b._id)] || 0) - (countByDriver[String(a._id)] || 0) ||
      new Date(b.updatedAt) - new Date(a.updatedAt) ||
      String(b._id).localeCompare(String(a._id))
    );
    const total = matching.length;
    const pageIds = matching.slice(skip, skip + Number(limit)).map((m) => m._id);

    const rows = await Driver.find({ _id: { $in: pageIds } }).select('-password').lean();
    const rowById = new Map(rows.map((r) => [String(r._id), r]));
    const drivers = pageIds.map((id) => rowById.get(String(id))).filter(Boolean);
    drivers.forEach((d) => { d.docCount = countByDriver[String(d._id)] || 0; });

    res.json({
      success: true,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      data: drivers
    });
  } catch (err) {
    console.error('listDrivers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Get a single driver's full profile and KYC docs ─────────────────────
// GET /api/v1/admin/drivers/:driverId
exports.getDriver = async (req, res) => {
  try {
    const { driverId } = req.params;

    const driver = await Driver.findById(driverId).select('-password');
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const kycDocs = await Kyc.find({ driver: driverId }).sort({ uploadedAt: -1 });

    res.json({ success: true, data: { driver, kycDocs } });
  } catch (err) {
    console.error('getDriver error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Edit a driver's profile details (admin) ─────────────────────────────
// PUT /api/v1/admin/drivers/:driverId
// Editable: name, email, phone, DOB, address, licence details, Aadhaar/PAN
// numbers and languages. Deliberately NOT editable here: password/session,
// KYC status and the KYC documents (their own approve/reject flows), rating,
// and bank details. Only the fields present in the body are touched, so the
// panel can send just what changed.
const DRIVER_ADDRESS_FIELDS = ['line1', 'city', 'state', 'country', 'pinCode'];
const DRIVER_LICENSE_FIELDS = ['number', 'validTill'];
const DRIVER_DOC_NUMBER_FIELDS = ['aadharNumber', 'panCardNumber'];

function toStringList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

exports.updateDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const body = req.body || {};

    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    let touched = false;

    if (body.name !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name) return res.status(400).json({ error: "Name can't be empty" });
      if (name.length > 150) return res.status(400).json({ error: 'Name is too long (max 150 characters)' });
      driver.name = name;
      touched = true;
    }

    // Email/phone have sparse unique indexes — an empty string would count as
    // a real value and collide with every other blank one, so clearing means
    // removing the field, not setting ''.
    if (body.email !== undefined) {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Enter a valid email address' });
      }
      driver.email = email || undefined;
      touched = true;
    }
    if (body.phone !== undefined) {
      const phone = String(body.phone ?? '').trim();
      if (phone && String(phone).replace(/\D/g, '').length < 10) {
        return res.status(400).json({ error: 'Enter a valid phone number (at least 10 digits)' });
      }
      driver.phone = phone || undefined; // normalized to 91xxxxxxxxxx by the model's pre-save hook
      touched = true;
    }

    if (body.dob !== undefined) {
      const raw = String(body.dob ?? '').trim();
      if (!raw) {
        driver.dob = undefined;
      } else {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Enter a valid date of birth (YYYY-MM-DD)' });
        driver.dob = d;
      }
      touched = true;
    }

    const setNested = (group, fields, incoming) => {
      if (!incoming || typeof incoming !== 'object') return null;
      for (const f of fields) {
        if (incoming[f] === undefined) continue;
        const val = String(incoming[f] ?? '').trim();
        if (val.length > 200) return `${group}.${f} is too long (max 200 characters)`;
        driver.set(`${group}.${f}`, val);
        touched = true;
      }
      return null;
    };
    let err = setNested('address', DRIVER_ADDRESS_FIELDS, body.address)
      || setNested('license', DRIVER_LICENSE_FIELDS, body.license)
      || setNested('documents', DRIVER_DOC_NUMBER_FIELDS, body.documents);
    if (err) return res.status(400).json({ error: err });

    if (body.license && body.license.types !== undefined) {
      driver.set('license.types', toStringList(body.license.types));
      touched = true;
    }
    if (body.languages !== undefined) {
      driver.languages = toStringList(body.languages);
      touched = true;
    }

    if (!touched) {
      return res.status(400).json({ error: 'No editable fields provided' });
    }

    await driver.save();
    const updated = await Driver.findById(driverId).select('-password');
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('updateDriver error:', err);
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'value';
      return res.status(409).json({ error: `Another driver already uses this ${field}` });
    }
    if (err.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid driver id' });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Approve / reject a driver's overall KYC ─────────────────────────────
// PUT /api/v1/admin/drivers/:driverId/approve
exports.approveDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { kycStatus, rejectionReason } = req.body;

    if (!STATUS_VALUES.includes(kycStatus)) {
      return res.status(400).json({ error: 'Invalid kycStatus. Must be pending, approved, or rejected' });
    }

    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    driver.kycStatus = kycStatus;
    driver.kycRejectionReason = kycStatus === 'rejected' ? (rejectionReason || '') : '';
    await driver.save();

    if (kycStatus === 'approved') {
      await notifyDriver(
        driverId,
        '🎉 KYC Verified Successfully',
        'Your KYC documents have been reviewed and approved. You are now a fully verified Woglo driver!',
        'kycApproved'
      );
    } else if (kycStatus === 'rejected') {
      await notifyDriver(
        driverId,
        '❌ KYC Verification Rejected',
        rejectionReason
          ? `Your KYC was rejected: ${rejectionReason}. Please update your documents and resubmit.`
          : 'Your KYC was rejected. Please update your documents and resubmit.',
        'kycRejected'
      );
    } else if (kycStatus === 'pending') {
      await notifyDriver(
        driverId,
        '⏳ KYC Documents Under Review',
        'Your KYC documents have been received and are currently under review. We will notify you once approved.',
        'kycPending'
      );
    }

    const updated = await Driver.findById(driverId).select('-password');
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('approveDriver error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Approve / reject a single KYC document ──────────────────────────────
// PUT /api/v1/admin/drivers/:driverId/kyc/:kycId
exports.updateKycDocStatus = async (req, res) => {
  try {
    const { driverId, kycId } = req.params;
    const { status, rejectionReason } = req.body;

    if (!STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be pending, approved, or rejected' });
    }

    const kyc = await Kyc.findOne({ _id: kycId, driver: driverId });
    if (!kyc) {
      return res.status(404).json({ error: 'KYC document not found for this driver' });
    }

    kyc.status = status;
    kyc.rejectionReason = status === 'rejected' ? (rejectionReason || '') : '';
    await kyc.save();

    if (status === 'rejected') {
      await notifyDriver(
        driverId,
        `❌ Document Rejected: ${kyc.type}`,
        rejectionReason
          ? `Your ${kyc.type} was rejected: ${rejectionReason}. Please re-upload a valid document.`
          : `Your ${kyc.type} was rejected. Please re-upload a valid document.`,
        'docRejected'
      );
    } else if (status === 'approved') {
      await notifyDriver(
        driverId,
        `✅ Document Verified: ${kyc.type}`,
        `Your ${kyc.type} has been successfully approved.`,
        'docApproved'
      );
    }

    const driver = await recomputeDriverKycStatus(driverId);

    res.json({ success: true, data: kyc, driverKycStatus: driver ? driver.kycStatus : undefined });
  } catch (err) {
    console.error('updateKycDocStatus error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
