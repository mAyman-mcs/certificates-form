const XLSX = require('xlsx');

const NAME_ROW = 4; // 0-indexed row 5 (employee name header)
const HEADER_ROW = 5; // 0-indexed row 6 ("Vendor name" / "Certificate name" / "Exipration date")
const DATA_START_ROW = 6; // 0-indexed row 7
const BLOCK_FIRST_COL = 1; // 0-indexed col B
const BLOCK_WIDTH = 4; // Vendor, Certificate, Expiration, blank spacer

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const NO_EXPIRATION_TEXT = new Set(['n/a', 'na', 'no exp', 'not exp', 'no expiration', 'never', 'does not expire']);
const EXPIRED_TEXT = new Set(['expired', 'exp']);
const UNKNOWN_TEXT = new Set(['no exp', 'noexp']); // kept separate for clarity if needed later

function cleanString(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/\s+/g, ' ');
}

/** Parses the many free-text expiration formats found in the sheet. */
function parseExpirationRaw(raw) {
  const text = cleanString(raw);
  if (raw instanceof Date) {
    return { date: raw, text: raw.toISOString().slice(0, 10), kind: 'date' };
  }
  if (!text) {
    return { date: null, text: '', kind: 'blank' };
  }
  const lower = text.toLowerCase();
  if (NO_EXPIRATION_TEXT.has(lower)) {
    return { date: null, text, kind: 'no_expiration' };
  }
  if (EXPIRED_TEXT.has(lower)) {
    return { date: null, text, kind: 'expired_flag' };
  }

  // YYYY-MM-DD (ISO, e.g. from an <input type="date">)
  let iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10)));
    if (!isNaN(d.getTime())) return { date: d, text, kind: 'date' };
  }

  // DD-MM-YYYY or D-M-YYYY (the sheet uses day-month-year, not US month-day-year)
  let m = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d.getTime())) return { date: d, text, kind: 'date' };
  }

  // "MON, YYYY" or "MON YYYY" e.g. "FEB, 2027" -> treat as last day of that month
  m = text.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (m) {
    const monthKey = m[1].slice(0, 3).toLowerCase();
    if (monthKey in MONTHS) {
      const year = parseInt(m[2], 10);
      const month = MONTHS[monthKey];
      const lastDay = new Date(Date.UTC(year, month + 1, 0));
      return { date: lastDay, text, kind: 'date' };
    }
  }

  // "Month D, YYYY" e.g. "July 13, 2026" - native Date parses this reliably
  const native = new Date(text);
  if (!isNaN(native.getTime()) && /[A-Za-z]/.test(text)) {
    return { date: native, text, kind: 'date' };
  }

  // Anything else we can't confidently parse (e.g. "no exp", "NO exp", typos)
  if (lower.includes('exp')) {
    return { date: null, text, kind: 'no_expiration' };
  }

  return { date: null, text, kind: 'unknown' };
}

function computeStatus(kind, date, now) {
  if (kind === 'expired_flag') return 'expired';
  if (kind === 'no_expiration') return 'no_expiration';
  if (kind === 'blank') return 'unknown';
  if (kind === 'unknown') return 'unknown';
  if (kind === 'date' && date) {
    const daysLeft = Math.floor((date.getTime() - now.getTime()) / 86400000);
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= 90) return 'expiring_soon';
    return 'valid';
  }
  return 'unknown';
}

/**
 * Parses the workbook's fixed layout: 14 employee blocks of 4 columns
 * (Vendor name, Certificate name, Expiration date, blank spacer) starting
 * at column B, with the employee name merged across the block in row 5.
 *
 * Returns raw records (no `status`) — status depends on "now" and is
 * computed separately via computeStatus() at serve time, so it stays
 * correct without needing to re-parse the workbook every day.
 */
function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  const records = [];
  const maxCol = rows.reduce((max, r) => Math.max(max, r.length), 0);

  for (let col = BLOCK_FIRST_COL; col < maxCol; col += BLOCK_WIDTH) {
    const employeeName = cleanString(rows[NAME_ROW] && rows[NAME_ROW][col]);
    if (!employeeName) continue;

    for (let r = DATA_START_ROW; r < rows.length; r++) {
      const row = rows[r] || [];
      const vendor = cleanString(row[col]);
      const certificate = cleanString(row[col + 1]);
      const expirationRaw = row[col + 2];

      if (!vendor && !certificate) continue;

      const { date, text, kind } = parseExpirationRaw(expirationRaw);

      records.push({
        employee: employeeName,
        vendor: vendor || 'Unknown',
        certificate: certificate || 'Unknown',
        expirationDate: date ? date.toISOString().slice(0, 10) : null,
        expirationText: text,
        kind,
      });
    }
  }

  return records;
}

module.exports = { parseWorkbook, parseExpirationRaw, computeStatus };
