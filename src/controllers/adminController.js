const Admin = require('../models/Admin');
const Driver = require('../models/Driver');
const Kyc = require('../models/Kyc');
const Notification = require('../models/Notification');
const generateToken = require('../utils/generateToken');
const { deleteDriverAccountCascade } = require('./driverController');
const { sendWhatsAppReminder } = require('../utils/otpService');

// Each inner array is one requirement slot; any type within it satisfies that
// slot. The app no longer collects a third identity document (PAN Card /
// Identity Proof) at all — dropping this slot only ever makes recomputed
// KYC status easier to satisfy, so it can't demote anyone already approved.
const REQUIRED_DOC_GROUPS = [
  ['Driving License'],
  ['Aadhar Card'],
];
const STATUS_VALUES = ['pending', 'approved', 'rejected'];

// profilePicture can be an unbounded raw base64 string — the same field that
// OOM-crashed this backend when embedded in every row of a bulk list. Never
// select it raw for list endpoints; point at the photo-proxy endpoint
// instead (serves the same bytes on demand rather than inline in every row).
function driverPhotoUrl(req, driverId, hasPhoto) {
  if (!hasPhoto) return null;
  return `${req.protocol}://${req.get('host')}/api/v1/driver/${driverId}/photo`;
}

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
  // Independent reads — Driver isn't needed until after docs are computed,
  // so there's no reason to wait for one before starting the other.
  const [docs, driver] = await Promise.all([
    Kyc.find({ driver: driverId }).sort({ uploadedAt: 1 }),
    Driver.findById(driverId),
  ]);
  if (!driver) return null;

  const latestByType = {};
  docs.forEach((d) => { latestByType[d.type] = d; }); // later entries overwrite earlier ones

  const hasRejected = docs.some((d) => d.status === 'rejected');
  const allRequiredApproved = REQUIRED_DOC_GROUPS.every(
    (group) => group.some((t) => latestByType[t] && latestByType[t].status === 'approved')
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
exports.recomputeDriverKycStatus = recomputeDriverKycStatus;

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
    const matching = await Driver.find(filter).select('_id updatedAt').lean();
    // Scoped to just the matched drivers — this used to aggregate the ENTIRE
    // Kyc collection on every call regardless of the current filter (e.g.
    // viewing "rejected" with 5 drivers still scanned every KYC doc system-
    // wide), which fires on every admin login since Drivers is the default
    // landing tab.
    const docCounts = await Kyc.aggregate([
      { $match: { driver: { $in: matching.map((m) => m._id) } } },
      { $group: { _id: '$driver', count: { $sum: 1 } } },
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

    const [rows, withPhoto] = await Promise.all([
      Driver.find({ _id: { $in: pageIds } }).select('-password -profilePicture').lean(),
      Driver.find({ _id: { $in: pageIds }, profilePicture: { $exists: true, $ne: null } }).select('_id').lean(),
    ]);
    const rowById = new Map(rows.map((r) => [String(r._id), r]));
    const drivers = pageIds.map((id) => rowById.get(String(id))).filter(Boolean);
    const hasPhotoSet = new Set(withPhoto.map((w) => String(w._id)));
    drivers.forEach((d) => {
      d.docCount = countByDriver[String(d._id)] || 0;
      d.photoUrl = driverPhotoUrl(req, d._id, hasPhotoSet.has(String(d._id)));
    });

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

// ─── Solutions & Quota: drivers with no documents uploaded, or a rejected
// KYC — mirrors woglo-backend's listVendorIssues/sendVendorReminder for the
// admin panel's Issues section (drivers have no "missing location"
// equivalent — that's a vendor/garage concept).
// GET /api/v1/admin/driver-issues
exports.listDriverIssues = async (req, res) => {
  try {
    const drivers = await Driver.find({ kycStatus: { $ne: 'approved' } })
      .select('name phone email kycStatus kycRejectionReason')
      .lean();
    const driverIds = drivers.map((d) => d._id);

    const docCounts = await Kyc.aggregate([
      { $match: { driver: { $in: driverIds } } },
      { $group: { _id: '$driver', count: { $sum: 1 } } },
    ]);
    const countByDriver = {};
    docCounts.forEach((c) => { countByDriver[String(c._id)] = c.count; });

    const results = [];
    for (const driver of drivers) {
      const uploadedDocCount = countByDriver[String(driver._id)] || 0;
      const missingDocuments = uploadedDocCount === 0;
      const kycRejected = driver.kycStatus === 'rejected';
      if (!missingDocuments && !kycRejected) continue;

      results.push({
        driverId: String(driver._id),
        name: driver.name || 'Unnamed Driver',
        email: driver.email || '—',
        phone: driver.phone || '—',
        kycStatus: driver.kycStatus || 'pending',
        missingDocuments,
        kycRejected,
        rejectionReason: kycRejected ? driver.kycRejectionReason || '' : '',
        uploadedDocCount,
      });
    }

    res.json({
      success: true,
      total: results.length,
      counts: {
        missingDocuments: results.filter((r) => r.missingDocuments).length,
        kycRejected: results.filter((r) => r.kycRejected).length,
      },
      data: results,
    });
  } catch (err) {
    console.error('listDriverIssues error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

const DRIVER_ISSUE_REMINDER_CONTENT = {
  missingDocuments: {
    title: '⚠️ Upload your Agency Verification documents',
    message: 'Your account is missing its Agency Verification documents. Upload them in the app so we can review and verify your account.',
  },
};

// ─── Send a real in-app reminder to a driver for one of the issues above ──
// POST /api/v1/admin/drivers/:driverId/send-reminder  { issueType }
// Creates a genuine Notification the driver sees on their own Notifications
// page, plus a best-effort WhatsApp message — an explicit admin action, not
// something sent automatically just because the driver shows up in the
// issues list.
exports.sendDriverReminder = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { issueType, message: customMessage, title: customTitle } = req.body;

    let content;
    if (customMessage && String(customMessage).trim()) {
      content = { title: (customTitle && String(customTitle).trim()) || '📢 Message from Woglo Admin', message: String(customMessage).trim() };
    } else {
      content = DRIVER_ISSUE_REMINDER_CONTENT[issueType];
      if (!content) {
        return res.status(400).json({ error: 'issueType must be missingDocuments, or provide a custom message' });
      }
    }

    const driver = await Driver.findById(driverId).select('name phone');
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    await Notification.create({
      driver: driverId,
      title: content.title,
      message: content.message,
      type: 'general',
    });

    // Best-effort — a driver with no phone on file, or the WhatsApp template
    // not being approved yet, shouldn't fail the whole reminder when the
    // in-app notification already went out fine.
    let whatsapp = { attempted: false, sent: false };
    if (driver.phone) {
      whatsapp.attempted = true;
      try {
        await sendWhatsAppReminder(driver.phone, { name: driver.name || 'there', message: content.message });
        whatsapp.sent = true;
      } catch (waErr) {
        console.error('sendDriverReminder WhatsApp send failed:', waErr.response?.data || waErr.message);
      }
    }

    res.json({ success: true, message: 'Reminder sent', whatsapp });
  } catch (err) {
    console.error('sendDriverReminder error:', err);
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

// ─── Delete a driver account — full cascade, no undo ─────────────────────
// DELETE /api/v1/admin/drivers/:driverId
exports.deleteDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    const result = await deleteDriverAccountCascade(driverId);
    if (!result.success) {
      return res.status(result.status || 500).json({ error: result.error });
    }
    res.json({ success: true, message: 'Driver and all associated data deleted' });
  } catch (err) {
    console.error('deleteDriver error:', err);
    if (err.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid driver id' });
    }
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

    res.json({
      success: true,
      data: kyc,
      driverKycStatus: driver ? driver.kycStatus : undefined,
      driverKycRejectionReason: driver ? driver.kycRejectionReason : undefined,
    });
  } catch (err) {
    console.error('updateKycDocStatus error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Admin deletes a single KYC document ─────────────────────────────────
// DELETE /api/v1/admin/drivers/:driverId/kyc/:kycId
// Removes the document entirely (not a rejection — the driver has to
// upload it again from scratch), then recomputes the driver's overall
// kycStatus from whatever documents remain.
exports.deleteKycDoc = async (req, res) => {
  try {
    const { driverId, kycId } = req.params;

    const kyc = await Kyc.findOneAndDelete({ _id: kycId, driver: driverId });
    if (!kyc) {
      return res.status(404).json({ error: 'KYC document not found for this driver' });
    }

    const driver = await recomputeDriverKycStatus(driverId);

    res.json({
      success: true,
      driverKycStatus: driver ? driver.kycStatus : undefined,
      driverKycRejectionReason: driver ? driver.kycRejectionReason : undefined,
    });
  } catch (err) {
    console.error('deleteKycDoc error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
