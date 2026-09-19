const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../../db/connection');

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const SALT_ROUNDS = 10;

// Same env var db/seed.js uses, so there's one knob for "the initial password
// every account starts with" whether it's seeded or created via the admin UI.
// Not a secret — must_reset_password forces it to be changed on first login.
const DEFAULT_INITIAL_PASSWORD = process.env.SEED_DEFAULT_PASSWORD || 'P@ssw0rd';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required.');
  return secret;
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, mustResetPassword: user.must_reset_password },
    getSecret(),
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

// Every user-row query below selects columns explicitly rather than `*` so
// the (potentially ~2MB) profile_photo bytes are never fetched except by the
// dedicated photo-serving route — login/lookup only need to know one exists.
const USER_COLUMNS = `
  id, full_name, email, department, role, must_reset_password, profile_photo_url,
  (profile_photo IS NOT NULL) AS has_profile_photo
`;

function toPublicUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    department: user.department,
    role: user.role,
    mustResetPassword: user.must_reset_password,
    profilePhotoUrl: user.profile_photo_url,
    hasProfilePhoto: Boolean(user.has_profile_photo),
  };
}

async function getById(userId) {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return rows[0] ? toPublicUser(rows[0]) : null;
}

/** Returns { token, user } on success, or null on bad credentials. */
async function login(email, password) {
  const { rows } = await pool.query(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [email]
  );
  const user = rows[0];
  if (!user) return null;

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;

  return { token: issueToken(user), user: toPublicUser(user) };
}

/**
 * Verifies the user's current password (the admin-issued temp password on
 * first login, or their existing one otherwise), then sets a new one and
 * clears must_reset_password. Returns a fresh { token, user }.
 */
async function setPassword(userId, currentPassword, newPassword) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw new Error('User not found.');

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) throw new Error('Current password is incorrect.');

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const { rows: updatedRows } = await pool.query(
    `UPDATE users SET password_hash = $1, must_reset_password = false
     WHERE id = $2 RETURNING ${USER_COLUMNS}`,
    [passwordHash, userId]
  );

  const updated = updatedRows[0];
  return { token: issueToken(updated), user: toPublicUser(updated) };
}

/**
 * Admin-only provisioning: creates a user with a temp password and
 * must_reset_password = true. Returns the plaintext temp password once, so
 * the admin can hand it to the new user (there's no email delivery here).
 * Every user starts with the same known password (DEFAULT_INITIAL_PASSWORD)
 * unless the caller explicitly passes a different one.
 */
async function createUser({
  fullName,
  email,
  department,
  role = 'employee',
  tempPassword = DEFAULT_INITIAL_PASSWORD,
  photoBuffer = null,
  photoMimeType = null,
}) {
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  const { rows } = await pool.query(
    `INSERT INTO users
       (full_name, email, department, role, password_hash, must_reset_password,
        profile_photo, profile_photo_type)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)
     RETURNING ${USER_COLUMNS}`,
    [fullName, email, department || null, role, passwordHash, photoBuffer, photoMimeType]
  );

  return { user: toPublicUser(rows[0]), tempPassword };
}

module.exports = { login, setPassword, createUser, getById, issueToken, verifyToken, toPublicUser };
