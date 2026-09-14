// Many rows in the source sheet (and free-typed manual entries) refer to the
// same vendor or certificate but differ only in whitespace or letter case,
// e.g. "Palo Alto" / "palo alto" / "Paloalto", "OpenText" / "Opentext".
// This groups those together and picks one canonical spelling per group —
// the most common exact spelling seen in the data — so the UI doesn't show
// the same thing multiple times as if they were different.

function collapseWhitespace(str) {
  return String(str || '').trim().replace(/\s+/g, ' ');
}

// Grouping key ignores ALL whitespace (not just collapses it) so that
// "Palo Alto", "palo alto", and "Paloalto" are recognized as the same
// vendor despite the sheet being inconsistent about the space between words.
function normKey(str) {
  return collapseWhitespace(str).toLowerCase().replace(/\s+/g, '');
}

/**
 * Builds a lowercase-key -> canonical-display-form map from a list of raw
 * strings. Canonical form is whichever exact (whitespace-collapsed) spelling
 * occurs most often for that key; ties go to whichever was seen first.
 */
function buildCanonicalMap(values) {
  const formCounts = new Map(); // key -> Map(exactForm -> count)
  const firstSeen = new Map(); // key -> exactForm -> first index seen
  let index = 0;

  for (const raw of values) {
    const exact = collapseWhitespace(raw);
    if (!exact) continue;
    const key = normKey(exact);

    if (!formCounts.has(key)) formCounts.set(key, new Map());
    const counts = formCounts.get(key);
    counts.set(exact, (counts.get(exact) || 0) + 1);

    if (!firstSeen.has(key)) firstSeen.set(key, new Map());
    const seenMap = firstSeen.get(key);
    if (!seenMap.has(exact)) seenMap.set(exact, index);

    index += 1;
  }

  const canonical = new Map();
  for (const [key, counts] of formCounts) {
    let best = null;
    let bestCount = -1;
    let bestSeenAt = Infinity;
    for (const [form, count] of counts) {
      const seenAt = firstSeen.get(key).get(form);
      if (count > bestCount || (count === bestCount && seenAt < bestSeenAt)) {
        best = form;
        bestCount = count;
        bestSeenAt = seenAt;
      }
    }
    canonical.set(key, best);
  }
  return canonical;
}

function applyCanonicalMap(map, raw) {
  const exact = collapseWhitespace(raw);
  if (!exact) return exact;
  return map.get(normKey(exact)) || exact;
}

/** Normalizes vendor and certificate spelling across a list of records. */
function normalizeRecords(records) {
  const vendorMap = buildCanonicalMap(records.map((r) => r.vendor));
  const certificateMap = buildCanonicalMap(records.map((r) => r.certificate));

  return records.map((r) => ({
    ...r,
    vendor: applyCanonicalMap(vendorMap, r.vendor),
    certificate: applyCanonicalMap(certificateMap, r.certificate),
  }));
}

module.exports = { normalizeRecords, buildCanonicalMap, applyCanonicalMap, collapseWhitespace };
