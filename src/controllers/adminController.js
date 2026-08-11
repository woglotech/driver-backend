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
exports.listDrivers = async (req, res) => {
  try {
    const { kycStatus, page = 1, limit = 20, search } = req.query;

    const filter = {};
    if (kycStatus) {
      if (!STATUS_VALUES.includes(kycStatus)) {
        return res.status(400).json({ error: 'Invalid kycStatus filter. Must be pending, approved, or rejected' });
      }
      filter.kycStatus = kycStatus;
    }
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { email: re }, { phone: re }, { driverId: re }];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [drivers, total] = await Promise.all([
      Driver.find(filter)
        .select('-password')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Driver.countDocuments(filter)
    ]);

    const docCounts = await Kyc.aggregate([
      { $match: { driver: { $in: drivers.map((d) => d._id) } } },
      { $group: { _id: '$driver', count: { $sum: 1 } } },
    ]);
    const countByDriver = {};
    docCounts.forEach((c) => { countByDriver[c._id.toString()] = c.count; });
    drivers.forEach((d) => { d.docCount = countByDriver[d._id.toString()] || 0; });

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
