const AppVersion = require('../models/AppVersion');
const compareVersions = require('../utils/compareVersions');

// @desc    Check whether the calling app build must update before continuing
// @route   GET /api/v1/app/version-check?platform=android&version=1.0.1
// @access  Public
exports.checkVersion = async (req, res, next) => {
  try {
    const { platform, version } = req.query;

    if (!platform || !version) {
      res.status(400);
      throw new Error('Please provide platform and version');
    }

    const config = await AppVersion.findOne({ platform: String(platform).toLowerCase() });

    if (!config) {
      // No config for this platform yet — don't block installs over a
      // missing admin setup.
      return res.status(200).json({ forceUpdate: false });
    }

    const forceUpdate = compareVersions(version, config.minSupportedVersion) < 0;

    res.status(200).json({
      forceUpdate,
      latestVersion: config.latestVersion,
      minSupportedVersion: config.minSupportedVersion,
      updateMessage: config.updateMessage,
      storeUrl: config.storeUrl,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get the app version config for a platform
// @route   GET /api/v1/admin/app-version/:platform
// @access  Private (admin)
exports.getConfig = async (req, res, next) => {
  try {
    const platform = String(req.params.platform).toLowerCase();
    const config = await AppVersion.findOne({ platform });

    if (!config) {
      res.status(404);
      throw new Error(`No app version config found for platform "${platform}"`);
    }

    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
};

// @desc    Create or update the app version config for a platform
// @route   PUT /api/v1/admin/app-version/:platform
// @access  Private (admin)
exports.upsertConfig = async (req, res, next) => {
  try {
    const platform = String(req.params.platform).toLowerCase();
    if (!['android', 'ios'].includes(platform)) {
      res.status(400);
      throw new Error('platform must be "android" or "ios"');
    }

    const { latestVersion, minSupportedVersion, updateMessage, storeUrl } = req.body;

    if (!latestVersion || !minSupportedVersion || !storeUrl) {
      res.status(400);
      throw new Error('Please provide latestVersion, minSupportedVersion, and storeUrl');
    }

    const config = await AppVersion.findOneAndUpdate(
      { platform },
      {
        platform,
        latestVersion,
        minSupportedVersion,
        storeUrl,
        ...(updateMessage ? { updateMessage } : {}),
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
};
