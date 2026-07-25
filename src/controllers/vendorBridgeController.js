/**
 * Vendor Bridge Controller
 * These endpoints are called by the VENDOR BACKEND, not directly by the apps.
 * They are secured by a shared API key (VENDOR_DRIVER_API_KEY).
 *
 * Routes (all under /api/v1/vendor):
 *   GET  /drivers              - List all registered drivers for vendor to browse
 *   POST /send-request         - Create a VendorRequest for a specific driver
 *   GET  /driver-calendar/:id  - Read a driver's availability calendar
 *   POST /assign-vehicle       - Update a driver's vehicle record with assignment details
 */
const Driver = require('../models/Driver');
const Kyc = require('../models/Kyc');
const VendorRequest = require('../models/VendorRequest');
const Vehicle = require('../models/Vehicle');
const Event = require('../models/Event');
const Notification = require('../models/Notification');

// ── Per-document KYC status for a set of drivers ───────────────────────────
// Mirrors adminController's recomputeDriverKycStatus "latest entry wins"
// logic, but keyed per document type instead of collapsed into one overall
// status, so the vendor app can show real admin-reviewed status per document.
async function getKycStatusByDriver(driverIds) {
  const docs = await Kyc.find({ driver: { $in: driverIds } })
    .sort({ uploadedAt: 1 })
    .lean();

  const byDriver = {};
  docs.forEach((d) => {
    const key = d.driver.toString();
    if (!byDriver[key]) byDriver[key] = {};
    byDriver[key][d.type] = d.status; // later (later-uploaded) entries overwrite
  });
  return byDriver;
}

function buildDocumentStatus(kycByType) {
  const get = (type) => (kycByType && kycByType[type]) || 'not_uploaded';
  return {
    license: get('Driving License'),
    aadhaar: get('Aadhar Card'),
    pan: get('PAN Card'),
  };
}

// ──────────────────────────────────────────────────────────────────
// GET /api/v1/vendor/drivers
// Returns all registered driver app users (name, phone, rating, etc.)
// ──────────────────────────────────────────────────────────────────
exports.getAvailableDrivers = async (req, res, next) => {
  try {
    const { search, vendorId } = req.query;
    let query = {};

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query = {
        $or: [
          { name: regex },
          { phone: regex },
          { driverId: regex },
        ],
      };
    }

    const drivers = await Driver.find(query).select('-password').lean();
    const driverIds = drivers.map(d => d._id);

    // If vendorId is provided, get their relationship status with these drivers
    let vendorRequests = [];
    let vendorVehicles = [];
    if (vendorId) {
      vendorRequests = await VendorRequest.find({
        vendorId,
        driver: { $in: driverIds },
      }).lean();
      vendorVehicles = await Vehicle.find({
        vendorId,
        driver: { $in: driverIds },
      }).lean();
    }

    const kycByDriver = await getKycStatusByDriver(driverIds);

    const mapped = drivers.map(d => {
      let invitationStatus = null;
      
      // Check if driver has a vehicle assigned by this vendor (Accepted)
      const hasVehicle = vendorVehicles.find(v => v.driver && v.driver.toString() === d._id.toString());
      if (hasVehicle) {
        invitationStatus = 'accepted';
      } else {
        // Check if there is a request
        const request = vendorRequests.find(r => r.driver && r.driver.toString() === d._id.toString());
        if (request) {
          invitationStatus = request.status; // 'pending' or 'accepted'
        }
      }

      return {
        id: d._id.toString(),
        driverId: d.driverId,
        fullName: d.name || '',
        phone: d.phone || '',
        age: d.dob
          ? Math.floor((Date.now() - new Date(d.dob)) / (365.25 * 24 * 60 * 60 * 1000))
          : 0,
        address: d.address
          ? [d.address.line1, d.address.city, d.address.state].filter(Boolean).join(', ')
          : '',
        licenseNumber: d.license?.number || '',
        licenseTypes: d.license?.types || [],
        aadhaarNumber: d.documents?.aadharNumber || '',
        panNumber: d.documents?.panCardNumber || '',
        photoUrl: d.profilePicture || null,
        rating: d.rating || 0,
        isVerified: d.isVerified || false,
        documentStatus: buildDocumentStatus(kycByDriver[d._id.toString()]),
        languages: d.languages || [],
        invitationStatus, // Real partnership status
        experience: null,
        totalTrips: null,
      };
    });

    res.json({ success: true, count: mapped.length, data: mapped });
  } catch (error) {
    next(error);
  }
};

// ──────────────────────────────────────────────────────────────────
// POST /api/v1/vendor/send-request
// Body: { driverId, vendorId, vendorName, agencyName, workLocation,
//         description, contactNumber, email, vehicleDetails }
// Creates a VendorRequest + notification for the driver
// ──────────────────────────────────────────────────────────────────
exports.sendVendorRequest = async (req, res, next) => {
  try {
    const {
      driverId,
      vendorId,
      vendorName,
      agencyName,
      workLocation,
      description,
      contactNumber,
      email,
      vehicleDetails,
    } = req.body;

    if (!driverId || !vendorId || !vendorName) {
      return res.status(400).json({
        success: false,
        error: 'driverId, vendorId and vendorName are required',
      });
    }

    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({ success: false, error: 'Driver not found' });
    }

    // Check if there's already a pending request from this vendor to this driver
    const existingRequest = await VendorRequest.findOne({
      driver: driverId,
      vendorId,
      status: 'pending',
    });
    if (existingRequest) {
      return res.status(409).json({
        success: false,
        error: 'A pending request from this vendor already exists for this driver',
      });
    }

    const request = await VendorRequest.create({
      vendorId,
      vendorName,
      agencyName,
      workLocation,
      description,
      contactNumber,
      email,
      driver: driverId,
      vehicleDetails: vehicleDetails || {},
    });

    // Push an in-app notification to the driver
    await Notification.create({
      driver: driverId,
      title: 'New Vendor Request',
      message: `${vendorName} has sent you a partnership request. Check Vendor Requests section.`,
      type: 'VENDOR_REQUEST',
      isRead: false,
    });

    res.status(201).json({
      success: true,
      data: {
        requestId: request._id,
        status: request.status,
        vendorName: request.vendorName,
        driverId: request.driver,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ──────────────────────────────────────────────────────────────────
// GET /api/v1/vendor/driver-calendar/:driverId
// Returns the driver's upcoming calendar events so vendor can see
// which dates the driver is available / on leave / booked
// ──────────────────────────────────────────────────────────────────
exports.getDriverCalendar = async (req, res, next) => {
  try {
    const { driverId } = req.params;

    const driver = await Driver.findById(driverId).select('_id name');
    if (!driver) {
      return res.status(404).json({ success: false, error: 'Driver not found' });
    }

    // Get events from today onwards (next 90 days)
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 90);

    const events = await Event.find({
      driver: driverId,
      date: { $gte: from, $lte: to },
    }).sort({ date: 1 });

    const mapped = events.map(e => ({
      id: e._id,
      type: e.type,           // 'available' | 'leave' | 'booked'
      date: e.date.toISOString().split('T')[0], // YYYY-MM-DD
      description: e.description || '',
    }));

    res.json({ success: true, driverId, driverName: driver.name, events: mapped });
  } catch (error) {
    next(error);
  }
};

// ──────────────────────────────────────────────────────────────────
// POST /api/v1/vendor/assign-vehicle
// Body: { driverId, vendorId, vendorName, agencyName, workLocation,
//         vehicleDetails: { make, model, licensePlate, color, vehicleType, seatingCapacity },
//         fromDate, toDate, contactNumber, email }
// Creates or updates the Vehicle record in the driver backend and
// marks those calendar days as 'booked'
// ──────────────────────────────────────────────────────────────────
exports.assignVehicle = async (req, res, next) => {
  try {
    const {
      driverId,
      vendorId,
      vendorName,
      agencyName,
      workLocation,
      contactNumber,
      email,
      vehicleDetails,
      fromDate,
      toDate,
    } = req.body;

    if (!driverId || !vehicleDetails?.licensePlate) {
      return res.status(400).json({
        success: false,
        error: 'driverId and vehicleDetails.licensePlate are required',
      });
    }

    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({ success: false, error: 'Driver not found' });
    }

    const fromDateObj = fromDate ? new Date(fromDate) : new Date();
    const toDateObj = toDate ? new Date(toDate) : null;

    // Upsert vehicle by licensePlate + driver
    let vehicle = await Vehicle.findOne({
      driver: driverId,
      licensePlate: vehicleDetails.licensePlate,
    });

    if (vehicle) {
      // Update existing
      vehicle.vendorId = vendorId;
      vehicle.vendorName = vendorName;
      vehicle.vendorContactNumber = contactNumber || vehicle.vendorContactNumber;
      vehicle.vendorEmail = email || vehicle.vendorEmail;
      vehicle.agencyName = agencyName || vehicle.agencyName;
      vehicle.workLocation = workLocation || vehicle.workLocation;
      vehicle.vehicleType = vehicleDetails.vehicleType || vehicle.vehicleType;
      vehicle.seatingCapacity = vehicleDetails.seatingCapacity || vehicle.seatingCapacity;
      vehicle.make = vehicleDetails.make || vehicle.make;
      vehicle.model = vehicleDetails.model || vehicle.model;
      vehicle.color = vehicleDetails.color || vehicle.color;
      vehicle.year = vehicleDetails.year || vehicle.year;
      vehicle.assignedFromDate = fromDateObj;
      vehicle.assignedToDate = toDateObj;
      vehicle.isApproved = true;
      await vehicle.save();
    } else {
      vehicle = await Vehicle.create({
        driver: driverId,
        make: vehicleDetails.make || 'Unknown',
        model: vehicleDetails.model || 'Unknown',
        year: vehicleDetails.year,
        licensePlate: vehicleDetails.licensePlate,
        color: vehicleDetails.color,
        vehicleType: vehicleDetails.vehicleType,
        seatingCapacity: vehicleDetails.seatingCapacity,
        isApproved: true,
        vendorId,
        vendorName,
        vendorContactNumber: contactNumber,
        vendorEmail: email,
        agencyName,
        workLocation,
        assignedFromDate: fromDateObj,
        assignedToDate: toDateObj,
        partnershipDate: fromDateObj,
      });
    }

    // Mark calendar days as 'booked' for the date range
    if (fromDateObj && toDateObj) {
      const cursor = new Date(fromDateObj);
      cursor.setHours(0, 0, 0, 0);
      const end = new Date(toDateObj);
      end.setHours(0, 0, 0, 0);

      while (cursor <= end) {
        const nextDay = new Date(cursor);
        nextDay.setDate(nextDay.getDate() + 1);

        const existing = await Event.findOne({
          driver: driverId,
          date: { $gte: cursor, $lt: nextDay },
        });

        const eventData = {
          type: 'booked',
          description: `Assigned to ${vendorName} - ${vehicleDetails.licensePlate}`,
        };

        if (existing) {
          // Don't overwrite leave with booked — vendor should not assign on leave days
          if (existing.type !== 'leave') {
            await Event.updateOne({ _id: existing._id }, eventData);
          }
        } else {
          await Event.create({
            driver: driverId,
            date: new Date(cursor),
            ...eventData,
          });
        }

        cursor.setDate(cursor.getDate() + 1);
      }
    } else if (fromDateObj) {
      // Just mark today if toDate is missing
      const cursor = new Date(fromDateObj);
      cursor.setHours(0, 0, 0, 0);
      const nextDay = new Date(cursor);
      nextDay.setDate(nextDay.getDate() + 1);

      const existing = await Event.findOne({
        driver: driverId,
        date: { $gte: cursor, $lt: nextDay },
      });

      const eventData = {
        type: 'booked',
        description: `Assigned to ${vendorName} - ${vehicleDetails.licensePlate}`,
      };

      if (!existing) {
        await Event.create({
          driver: driverId,
          date: new Date(cursor),
          ...eventData,
        });
      } else if (existing.type !== 'leave') {
        await Event.updateOne({ _id: existing._id }, eventData);
      }
    }

    // Notify driver of vehicle assignment
    await Notification.create({
      driver: driverId,
      title: 'Vehicle Assigned',
      message: `${vendorName} has assigned vehicle ${vehicleDetails.licensePlate} to you${
        fromDate ? ` from ${new Date(fromDate).toLocaleDateString('en-IN')}` : ''
      }${toDate ? ` to ${new Date(toDate).toLocaleDateString('en-IN')}` : ''}.`,
      type: 'VEHICLE_ASSIGNED',
      isRead: false,
    });

    res.json({
      success: true,
      data: {
        vehicleId: vehicle._id,
        licensePlate: vehicle.licensePlate,
        vendorName: vehicle.vendorName,
        assignedFromDate: vehicle.assignedFromDate,
        assignedToDate: vehicle.assignedToDate,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ──────────────────────────────────────────────────────────────────
// GET /api/v1/vendor/drivers/partnered/:vendorId
// Returns all drivers currently associated with a specific vendor
// (Drivers who have an active vehicle assignment from that vendor OR pending/accepted requests)
// ──────────────────────────────────────────────────────────────────
exports.getPartneredDrivers = async (req, res, next) => {
  try {
    const { vendorId } = req.params;

    if (!vendorId) {
      return res.status(400).json({ success: false, error: 'vendorId is required' });
    }

    // 1. Find all vehicles associated with this vendor
    const vehicles = await Vehicle.find({ vendorId }).populate('driver').lean();

    // 2. Find all non-rejected requests (pending or accepted)
    const requests = await VendorRequest.find({
      vendorId,
      status: { $in: ['pending', 'accepted'] },
    })
      .populate('driver')
      .lean();

    const driverIds = [
      ...requests.filter(r => r.driver).map(r => r.driver._id),
      ...vehicles.filter(v => v.driver).map(v => v.driver._id),
    ];
    const kycByDriver = await getKycStatusByDriver(driverIds);

    const driverMap = new Map();

    // Process requests first (set base status)
    requests.forEach(r => {
      if (r.driver) {
        const d = r.driver;
        const status = (r.status || 'pending').toLowerCase();

        driverMap.set(d._id.toString(), {
          id: d._id.toString(),
          driverId: d.driverId,
          fullName: d.name || '',
          phone: d.phone || '',
          age: d.dob
            ? Math.floor((Date.now() - new Date(d.dob)) / (365.25 * 24 * 60 * 60 * 1000))
            : 0,
          photoUrl: d.profilePicture || null,
          rating: d.rating || 0,
          isVerified: d.isVerified || false,
          documentStatus: buildDocumentStatus(kycByDriver[d._id.toString()]),
          languages: d.languages || [],
          invitationStatus: status, // 'pending' or 'accepted'
          assignedVehicleNumber: null,
          assignedFromDate: r.assignedFromDate || null,
          assignedToDate: r.assignedToDate || null,
        });
      }
    });

    // Process vehicles (overwrites/completes the request data)
    vehicles.forEach(v => {
      if (v.driver) {
        const d = v.driver;
        driverMap.set(d._id.toString(), {
          id: d._id.toString(),
          driverId: d.driverId,
          fullName: d.name || '',
          phone: d.phone || '',
          age: d.dob
            ? Math.floor((Date.now() - new Date(d.dob)) / (365.25 * 24 * 60 * 60 * 1000))
            : 0,
          photoUrl: d.profilePicture || null,
          rating: d.rating || 0,
          isVerified: d.isVerified || false,
          documentStatus: buildDocumentStatus(kycByDriver[d._id.toString()]),
          languages: d.languages || [],
          invitationStatus: 'accepted',
          assignedVehicleNumber: v.licensePlate,
          assignedFromDate: v.assignedFromDate,
          assignedToDate: v.assignedToDate,
        });
      }
    });

    const mapped = Array.from(driverMap.values());

    res.json({ success: true, count: mapped.length, data: mapped });
  } catch (error) {
    next(error);
  }
};

// ──────────────────────────────────────────────────────────────────
// DELETE /api/v1/vendor/partnership/:driverId/:vendorId
// Terminates the partnership: deletes requests, vehicle assignments,
// and clears the driver's calendar of slots booked by this vendor.
// ──────────────────────────────────────────────────────────────────
exports.removeVendorPartnership = async (req, res, next) => {
  try {
    const { driverId, vendorId } = req.params;

    if (!driverId || !vendorId) {
      return res.status(400).json({
        success: false,
        error: 'driverId and vendorId are required',
      });
    }

    // 1. Delete all vendor requests from this vendor for this driver
    const deletedRequests = await VendorRequest.deleteMany({
      driver: driverId,
      vendorId: vendorId,
    });

    // 2. Delete vehicle assignments from this vendor for this driver
    // We search by driver and vendorId to ensure we only remove the vendor's assignment
    const deletedVehicles = await Vehicle.deleteMany({
      driver: driverId,
      vendorId: vendorId,
    });

    // 3. Clear 'booked' events from driver calendar that were associated with this vendor
    // Since we don't have a direct link to the vendorId in the Event model,
    // we have to rely on the description or we can assume any 'booked' events
    // that overlap with the removed assignments should be reconsidered.
    // For now, let's look for events mentioning 'Assigned to' in description if possible,
    // or just remove all 'booked' events for simplicity if we can't be precise.
    // A safer way is to just remove events that mention 'Assigned to' since that's what assignVehicle does.
    
    await Event.deleteMany({
      driver: driverId,
      type: 'booked',
      description: { $regex: /Assigned to/i }
    });

    // 4. Notify driver
    await Notification.create({
      driver: driverId,
      title: 'Partnership Terminated',
      message: `A vendor has removed you from their driver list and unassigned any vehicles.`,
      type: 'PARTNERSHIP_REMOVED',
      isRead: false,
    });

    res.json({
      success: true,
      message: 'Partnership terminated successfully',
      details: {
        requestsDeleted: deletedRequests.deletedCount,
        vehiclesDeleted: deletedVehicles.deletedCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ──────────────────────────────────────────────────────────────────
// POST /api/v1/vendor/accept-request
// Body: { driverId, vendorId }
// Mocks a driver's acceptance of a vendor's request.
// ──────────────────────────────────────────────────────────────────
exports.acceptVendorRequest = async (req, res, next) => {
  try {
    const { driverId, vendorId } = req.body;

    if (!driverId || !vendorId) {
      return res.status(400).json({ success: false, error: 'driverId and vendorId are required' });
    }

    const request = await VendorRequest.findOne({ 
      driver: driverId, 
      vendorId: vendorId, 
      status: 'pending' 
    });

    if (!request) {
      return res.status(404).json({ success: false, error: 'No pending request found for this driver and vendor' });
    }

    request.status = 'accepted';
    await request.save();

    // Create vehicle record if details are available
    const vDetails = request.vehicleDetails || {};
    if (vDetails.make && vDetails.model && vDetails.licensePlate) {
      // Check if vehicle already exists for this driver/plate
      let vehicle = await Vehicle.findOne({ 
        driver: driverId, 
        licensePlate: vDetails.licensePlate 
      });

      if (!vehicle) {
        await Vehicle.create({
          driver: driverId,
          make: vDetails.make,
          model: vDetails.model,
          year: vDetails.year,
          licensePlate: vDetails.licensePlate,
          color: vDetails.color,
          isApproved: true,
          vendorId: vendorId,
          vendorName: request.vendorName,
          agencyName: request.agencyName,
          workLocation: request.workLocation,
          description: request.description,
          partnershipDate: new Date()
        });
      }
    }

    // Notify driver
    await Notification.create({
      driver: driverId,
      title: 'Partnership Accepted (Simulation)',
      message: `Your partnership with ${request.vendorName} has been simulated as accepted.`,
      type: 'VENDOR_REQUEST',
      isRead: false,
    });

    res.json({ success: true, message: 'Request accepted successfully' });
  } catch (error) {
    next(error);
  }
};

// ──────────────────────────────────────────────────────────────────
// DELETE /api/v1/vendor/vendor-account/:vendorId
// Called by Vendor Backend when a vendor deletes their account.
// Removes ALL VendorRequests + Vehicles + calendar events for this vendor
// across ALL drivers, so drivers' Vendor Requests and My Vehicles clear automatically.
// ──────────────────────────────────────────────────────────────────
exports.deleteVendorAccount = async (req, res, next) => {
  try {
    const { vendorId } = req.params;

    if (!vendorId) {
      return res.status(400).json({ success: false, error: 'vendorId is required' });
    }

    // 1. Find all vehicles assigned by this vendor (across all drivers)
    const vehicles = await Vehicle.find({ vendorId }).lean();

    // 2. Clear calendar events for each vehicle's license plate
    for (const v of vehicles) {
      if (v.licensePlate && v.driver) {
        await Event.deleteMany({
          driver: v.driver,
          type: 'booked',
          description: new RegExp(v.licensePlate, 'i'),
        });
      }
    }

    // 3. Delete all vehicles assigned by this vendor
    const deletedVehicles = await Vehicle.deleteMany({ vendorId });

    // 4. Delete all vendor requests from this vendor
    const deletedRequests = await VendorRequest.deleteMany({ vendorId });

    // 5. Notify all affected drivers
    const affectedDriverIds = [...new Set(vehicles.map(v => v.driver?.toString()).filter(Boolean))];
    for (const driverId of affectedDriverIds) {
      await Notification.create({
        driver: driverId,
        title: 'Vendor Account Deleted',
        message: 'A vendor you were partnered with has deleted their account. All associated requests and vehicle assignments have been removed.',
        type: 'PARTNERSHIP_REMOVED',
        isRead: false,
      });
    }

    res.json({
      success: true,
      message: 'Vendor account data removed from all drivers',
      details: {
        vehiclesDeleted: deletedVehicles.deletedCount,
        requestsDeleted: deletedRequests.deletedCount,
        driversNotified: affectedDriverIds.length,
      },
    });
  } catch (error) {
    next(error);
  }
};
