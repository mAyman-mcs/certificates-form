const pool = require('./connection');
const { ensureVendor } = require('./vendorsRepo');
const { computeStatus } = require('../lib/certStatus');

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];

// LEFT JOIN on the reviewer: reviewed_by is nullable and SET NULL on delete,
// so an inner join would silently drop rows whose reviewer was removed.
const SELECT_RECORDS = `
  SELECT c.id, c.user_id, u.full_name AS employee, v.name AS vendor,
         c.certificate_name AS certificate, c.expiration_date, c.expiration_text,
         c.kind, c.source, c.approval_status, c.rejection_reason, c.reference_link,
         c.reviewed_at, c.created_at, r.full_name AS reviewed_by_name
  FROM certificates c
  JOIN users u ON u.id = c.user_id
  JOIN vendors v ON v.id = c.vendor_id
  LEFT JOIN users r ON r.id = c.reviewed_by
`;

function toRecord(row, now = new Date()) {
  return {
    id: row.id,
    userId: row.user_id,
    employee: row.employee,
    vendor: row.vendor,
    certificate: row.certificate,
    expirationDate: row.expiration_date || null,
    expirationText: row.expiration_text || '',
    status: computeStatus(row.kind, row.expiration_date, now),
    approvalStatus: row.approval_status,
    rejectionReason: row.rejection_reason || null,
    referenceLink: row.reference_link || null,
    reviewedByName: row.reviewed_by_name || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
  };
}

/** Both filters are optional; pass null to skip one. */
async function list({ userId = null, approvalStatus = null } = {}) {
  const { rows } = await pool.query(
    `${SELECT_RECORDS}
     WHERE ($1::int IS NULL OR c.user_id = $1)
       AND ($2::text IS NULL OR c.approval_status = $2)
     ORDER BY u.full_name, v.name, c.certificate_name`,
    [userId, approvalStatus]
  );
  const now = new Date();
  return rows.map((row) => toRecord(row, now));
}

async function getById(id) {
  const { rows } = await pool.query(`${SELECT_RECORDS} WHERE c.id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Vendor resolution and the insert share one transaction, so a rejected
 * duplicate doesn't leave a newly-created vendor orphaned behind it.
 */
async function create({
  userId,
  vendorName,
  certificateName,
  expirationDate = null,
  referenceLink = null,
  approvalStatus = 'pending',
  requestedBy = null,
  reviewedBy = null,
  source = 'manual',
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vendorId = await ensureVendor(client, vendorName);
    const kind = expirationDate ? 'date' : 'no_expiration';
    const { rows } = await client.query(
      `INSERT INTO certificates
         (user_id, vendor_id, certificate_name, expiration_date, expiration_text,
          kind, source, approval_status, requested_by, reviewed_by, reviewed_at, reference_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $10::int IS NULL THEN NULL ELSE now() END, $11)
       RETURNING id`,
      [
        userId,
        vendorId,
        String(certificateName).trim(),
        expirationDate,
        expirationDate || '',
        kind,
        source,
        approvalStatus,
        requestedBy,
        reviewedBy,
        referenceLink,
      ]
    );
    await client.query('COMMIT');
    return getById(rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Guarded single statements — the WHERE clause is what prevents a
// read-then-write race between two admins acting on the same request.
async function approve(id, adminId) {
  const { rows } = await pool.query(
    `UPDATE certificates
        SET approval_status = 'approved', reviewed_by = $2, reviewed_at = now(),
            updated_at = now(), rejection_reason = NULL
      WHERE id = $1 AND approval_status = 'pending'
      RETURNING id`,
    [id, adminId]
  );
  return rows[0] ? getById(id) : null;
}

async function reject(id, adminId, reason) {
  const { rows } = await pool.query(
    `UPDATE certificates
        SET approval_status = 'rejected', reviewed_by = $2, reviewed_at = now(),
            updated_at = now(), rejection_reason = $3
      WHERE id = $1 AND approval_status = 'pending'
      RETURNING id`,
    [id, adminId, String(reason).trim()]
  );
  return rows[0] ? getById(id) : null;
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM certificates WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { list, getById, create, approve, reject, remove, toRecord, APPROVAL_STATUSES };
