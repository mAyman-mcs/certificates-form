const express = require('express');
const multer = require('multer');
const { createUser } = require('../auth/authService');
const { requireAuth, requireAdmin } = require('../auth/authMiddleware');
const { normalizeExpiration, normalizeReferenceLink } = require('../certificates/certificatesRouter');
const usersRepo = require('../../db/usersRepo');
const certificatesRepo = require('../../db/certificatesRepo');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const ROLES = ['admin', 'employee'];
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2MB — plenty for a profile photo, cheap to store as a row

// Buffered in memory (never touches disk) since it's going straight into the
// profile_photo BYTEA column, not a filesystem or S3.
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for a profile photo.'));
    }
    cb(null, true);
  },
});

// Express routes a thrown/next(err) from the upload middleware here instead
// of the handler — this is what turns "file too big" into a clean 400.
function uploadErrorHandler(err, req, res, next) {
  if (!err) return next();
  const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
    ? `Photo must be ${MAX_PHOTO_BYTES / (1024 * 1024)}MB or smaller.`
    : err.message || 'Could not process the uploaded photo.';
  res.status(400).json({ error: message });
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* ---------------------------------------------------------------- users --- */

router.get('/users', async (req, res) => {
  try {
    res.json({ users: await usersRepo.listWithCertCounts() });
  } catch (err) {
    console.error('List users failed:', err.message);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

// Provisions a user with a temp password (returned once, since there's no
// email delivery here) and must_reset_password = true. Accepts an optional
// "photo" file (multipart/form-data) stored directly in the users row.
router.post('/users', uploadPhoto.single('photo'), uploadErrorHandler, async (req, res) => {
  const { fullName, email, department, role } = req.body || {};
  if (!fullName || !email) {
    return res.status(400).json({ error: 'fullName and email are required.' });
  }
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}.` });
  }

  try {
    const result = await createUser({
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      department,
      role,
      photoBuffer: req.file ? req.file.buffer : null,
      photoMimeType: req.file ? req.file.mimetype : null,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    console.error('Create user failed:', err.message);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

router.patch('/users/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid user id.' });

  const { fullName, email, department, role, profilePhotoUrl } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}.` });
  }
  // Demoting yourself would lock you out of every admin action, including
  // undoing it. Same reasoning as the self-delete guard below.
  if (id === req.user.sub && role !== undefined && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role.' });
  }

  const fields = {};
  if (fullName !== undefined) fields.fullName = String(fullName).trim();
  if (email !== undefined) fields.email = String(email).trim().toLowerCase();
  if (department !== undefined) fields.department = department === null ? null : String(department).trim();
  if (role !== undefined) fields.role = role;
  if (profilePhotoUrl !== undefined) fields.profilePhotoUrl = profilePhotoUrl;

  try {
    const user = await usersRepo.update(id, fields);
    if (user === undefined) return res.status(400).json({ error: 'No updatable fields provided.' });
    if (user === null) return res.status(404).json({ error: 'User not found.' });
    res.json({ user });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    console.error('Update user failed:', err.message);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

router.delete('/users/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === req.user.sub) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  try {
    const deleted = await usersRepo.remove(id);
    if (!deleted) return res.status(404).json({ error: 'User not found.' });
    res.status(204).end();
  } catch (err) {
    console.error('Delete user failed:', err.message);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

/* --------------------------------------------------------- certificates --- */

// Admin adding a certificate on someone's behalf — lands approved, no review needed.
router.post('/certificates', async (req, res) => {
  const { userId, vendor, certificate, expirationDate, referenceLink } = req.body || {};
  const targetId = parseId(userId);
  if (!targetId) return res.status(400).json({ error: 'A valid userId is required.' });
  if (!vendor || !String(vendor).trim() || !certificate || !String(certificate).trim()) {
    return res.status(400).json({ error: 'vendor and certificate are required.' });
  }

  const expiration = normalizeExpiration(expirationDate);
  if (expiration === false) {
    return res.status(400).json({ error: 'expirationDate must be a valid YYYY-MM-DD date.' });
  }
  const link = normalizeReferenceLink(referenceLink);
  if (link === false) {
    return res.status(400).json({ error: 'referenceLink must be a valid http(s) URL.' });
  }

  try {
    if (!(await usersRepo.exists(targetId))) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const record = await certificatesRepo.create({
      userId: targetId,
      vendorName: vendor,
      certificateName: certificate,
      expirationDate: expiration,
      referenceLink: link,
      approvalStatus: 'approved',
      requestedBy: req.user.sub,
      reviewedBy: req.user.sub,
    });
    res.status(201).json({ ok: true, record });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That user already has this certificate pending or approved.' });
    }
    console.error('Create certificate failed:', err.message);
    res.status(500).json({ error: 'Failed to create certificate.' });
  }
});

router.post('/certificates/:id/approve', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid certificate id.' });

  try {
    const record = await certificatesRepo.approve(id, req.user.sub);
    if (record) return res.json({ ok: true, record });

    // Zero rows updated: either it doesn't exist or it wasn't pending.
    const existing = await certificatesRepo.getById(id);
    if (!existing) return res.status(404).json({ error: 'Certificate not found.' });
    res.status(409).json({ error: `This request is already ${existing.approvalStatus}.` });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An approved copy of this certificate already exists.' });
    }
    console.error('Approve failed:', err.message);
    res.status(500).json({ error: 'Failed to approve this request.' });
  }
});

router.post('/certificates/:id/reject', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid certificate id.' });

  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });

  try {
    const record = await certificatesRepo.reject(id, req.user.sub, reason);
    if (record) return res.json({ ok: true, record });

    const existing = await certificatesRepo.getById(id);
    if (!existing) return res.status(404).json({ error: 'Certificate not found.' });
    res.status(409).json({ error: `This request is already ${existing.approvalStatus}.` });
  } catch (err) {
    console.error('Reject failed:', err.message);
    res.status(500).json({ error: 'Failed to reject this request.' });
  }
});

router.delete('/certificates/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid certificate id.' });

  try {
    const deleted = await certificatesRepo.remove(id);
    if (!deleted) return res.status(404).json({ error: 'Certificate not found.' });
    res.status(204).end();
  } catch (err) {
    console.error('Delete certificate failed:', err.message);
    res.status(500).json({ error: 'Failed to delete certificate.' });
  }
});

module.exports = router;
