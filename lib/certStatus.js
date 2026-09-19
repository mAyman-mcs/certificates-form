const EXPIRING_SOON_DAYS = 90;

/**
 * Derives the expiry status shown in the UI. Kept as a computed value rather
 * than a stored column so it stays correct day to day without a rewrite job.
 *
 * `expirationDate` is the 'YYYY-MM-DD' string the DATE type parser in
 * db/connection.js hands back — parsed as UTC so the day can't drift.
 */
function computeStatus(kind, expirationDate, now = new Date()) {
  if (kind === 'expired_flag') return 'expired';
  if (kind === 'no_expiration') return 'no_expiration';

  if (kind === 'date' && expirationDate) {
    const expiresAt = Date.parse(`${expirationDate}T00:00:00Z`);
    if (Number.isNaN(expiresAt)) return 'unknown';

    const daysLeft = Math.floor((expiresAt - now.getTime()) / 86400000);
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= EXPIRING_SOON_DAYS) return 'expiring_soon';
    return 'valid';
  }

  return 'unknown'; // covers 'blank' and 'unknown'
}

module.exports = { computeStatus, EXPIRING_SOON_DAYS };
