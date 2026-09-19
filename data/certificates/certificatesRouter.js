const express = require('express');
const certificatesRepo = require('../../db/certificatesRepo');
const { APPROVAL_STATUSES } = require('../../db/certificatesRepo');

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the trimmed date, null when absent, or false when malformed. */
function normalizeExpiration(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!ISO_DATE.test(value)) return false;
  // Round-trips a real calendar date — rejects 2026-02-31 and friends.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  return value;
}

router.get('/', async (req, res) => {
  const approval = req.query.approval;
  if (approval !== undefined && !APPROVAL_STATUSES.includes(approval)) {
    return res.status(400).json({ error: `approval must be one of: ${APPROVAL_STATUSES.join(', ')}.` });
  }

  try {
    const records = await certificatesRepo.list({
      // Employees only ever see their own rows; identity is the user id now,
      // not a name match against the spreadsheet.
      userId: req.user.role === 'admin' ? null : req.user.sub,
      approvalStatus: approval || null,
    });
    res.json({ generatedAt: new Date().toISOString(), records });
  } catch (err) {
    console.error('Failed to list certificates:', err.message);
    res.status(500).json({ error: 'Could not load certificates.' });
  }
});

// An employee submitting a request for themselves. Admins adding a certificate
// for someone else use POST /api/admin/certificates instead.
router.post('/', async (req, res) => {
  const { vendor, certificate, expirationDate } = req.body || {};
  if (!vendor || !String(vendor).trim() || !certificate || !String(certificate).trim()) {
    return res.status(400).json({ error: 'vendor and certificate are required.' });
  }

  const expiration = normalizeExpiration(expirationDate);
  if (expiration === false) {
    return res.status(400).json({ error: 'expirationDate must be a valid YYYY-MM-DD date.' });
  }

  try {
    const record = await certificatesRepo.create({
      userId: req.user.sub,
      vendorName: vendor,
      certificateName: certificate,
      expirationDate: expiration,
      approvalStatus: 'pending',
      requestedBy: req.user.sub,
    });
    res.status(201).json({ ok: true, record });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have a pending or approved request for this certificate.' });
    }
    console.error('Failed to create certificate request:', err.message);
    res.status(500).json({ error: 'Could not submit this request.' });
  }
});

module.exports = { router, normalizeExpiration };
