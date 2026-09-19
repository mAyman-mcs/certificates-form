const pool = require('./connection');
const { toPublicUser } = require('../data/auth/authService');

// Whitelist of updatable fields. The SET clause is built from this map's
// VALUES only, never from request keys, so caller-controlled input can never
// reach the SQL string.
const UPDATABLE_COLUMNS = {
  fullName: 'full_name',
  email: 'email',
  department: 'department',
  role: 'role',
  profilePhotoUrl: 'profile_photo_url',
};

async function listWithCertCounts() {
  // Explicit columns, not u.* — this returns every user at once, and pulling
  // each one's (up to ~2MB) profile_photo bytes just to list names would be
  // the classic N-blob mistake.
  const { rows } = await pool.query(`
    SELECT u.id, u.full_name, u.email, u.department, u.role, u.must_reset_password,
           u.profile_photo_url, (u.profile_photo IS NOT NULL) AS has_profile_photo,
           COUNT(c.id) FILTER (WHERE c.approval_status = 'pending')  AS pending_count,
           COUNT(c.id) FILTER (WHERE c.approval_status = 'approved') AS approved_count,
           COUNT(c.id) FILTER (WHERE c.approval_status = 'rejected') AS rejected_count
    FROM users u
    LEFT JOIN certificates c ON c.user_id = u.id
    GROUP BY u.id
    ORDER BY u.full_name
  `);
  return rows.map((row) => ({
    ...toPublicUser(row),
    certCounts: {
      pending: Number(row.pending_count),
      approved: Number(row.approved_count),
      rejected: Number(row.rejected_count),
    },
  }));
}

/** `fields` is camelCase; unknown keys are ignored. Returns null if no such user. */
async function update(id, fields) {
  const sets = [];
  const params = [];

  for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
    if (fields[key] === undefined) continue;
    params.push(fields[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return undefined; // caller turns this into a 400

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, full_name, email, department, role, must_reset_password,
               profile_photo_url, (profile_photo IS NOT NULL) AS has_profile_photo`,
    params
  );
  return rows[0] ? toPublicUser(rows[0]) : null;
}

async function remove(id) {
  const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
  return rowCount > 0;
}

async function exists(id) {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
  return rows.length > 0;
}

/** The one place that actually reads the photo bytes. Null if none is set. */
async function getPhoto(id) {
  const { rows } = await pool.query(
    'SELECT profile_photo, profile_photo_type FROM users WHERE id = $1',
    [id]
  );
  const row = rows[0];
  if (!row || !row.profile_photo) return null;
  return { data: row.profile_photo, mimeType: row.profile_photo_type || 'application/octet-stream' };
}

module.exports = { listWithCertCounts, update, remove, exists, getPhoto, UPDATABLE_COLUMNS };
