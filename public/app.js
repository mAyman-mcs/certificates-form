const STATUS_LABEL = {
  valid: 'Valid',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  no_expiration: 'No expiration',
  unknown: 'Unknown',
};

let allRecords = [];
let sortKey = 'employee';
let sortDir = 1;
let allCertificates = [];
let lowerVendorToCertificates = new Map(); // lowercase vendor -> sorted unique certificates seen under it

const el = (id) => document.getElementById(id);

async function loadData() {
  const res = await fetch('/api/data');
  const data = await res.json();
  allRecords = data.records || [];
  el('loadedAt').textContent = data.loadedAt
    ? `Data loaded: ${new Date(data.loadedAt).toLocaleString()}`
    : 'No data loaded yet';
  populateFilterOptions();
  render();
}

function populateFilterOptions() {
  const employees = uniqueSorted(allRecords.map(r => r.employee));
  const vendors = uniqueSorted(allRecords.map(r => r.vendor));
  const certificates = uniqueSorted(allRecords.map(r => r.certificate));

  fillSelect('filterVendor', vendors);
  fillDatalist('employeeOptions', employees);
  fillDatalist('vendorOptions', vendors);
  fillDatalist('certificateOptions', certificates);

  allCertificates = certificates;
  lowerVendorToCertificates = buildVendorCertificateMap(allRecords);

  // Keep the certificate dropdown scoped to the currently selected vendor (if any).
  updateFilterCertificateOptionsForVendor(el('filterVendor').value);
}

function buildVendorCertificateMap(records) {
  const map = new Map();
  for (const r of records) {
    if (!r.vendor || !r.certificate) continue;
    const key = r.vendor.trim().toLowerCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(r.certificate);
  }
  const sorted = new Map();
  for (const [key, set] of map) {
    sorted.set(key, [...set].sort((a, b) => a.localeCompare(b)));
  }
  return sorted;
}

// For the main Certificate filter <select>: scope its options to
// the selected Vendor filter so a stale certificate can't be left selected
// under a vendor it doesn't belong to (which previously produced 0 rows).
function updateFilterCertificateOptionsForVendor(vendorValue) {
  const key = vendorValue.trim().toLowerCase();
  const matches = key ? lowerVendorToCertificates.get(key) : null;
  fillSelect('filterCertificate', matches || allCertificates);
}

// Same idea for the "+ Add certification" modal: once a vendor is picked,
// the certificate field's suggestions narrow to only certificates already
// on record for that vendor. Falls back to the full list for a blank or
// not-yet-recognized vendor (e.g. a brand-new one being typed).
function updateAddCertificateOptionsForVendor(vendorValue) {
  const key = vendorValue.trim().toLowerCase();
  const matches = key ? lowerVendorToCertificates.get(key) : null;
  fillDatalist('certificateOptions', matches || allCertificates);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function fillSelect(id, values) {
  const select = el(id);
  const current = select.value;
  const placeholder = select.options[0];
  select.innerHTML = '';
  select.appendChild(placeholder);
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  }
  if (values.includes(current)) select.value = current;
}

function fillDatalist(id, values) {
  const datalist = el(id);
  datalist.innerHTML = values.map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
}

function getFiltered() {
  const query = el('searchBox').value.trim().toLowerCase();
  const cert = el('filterCertificate').value;
  const vendor = el('filterVendor').value;
  const status = el('filterStatus').value;

  return allRecords.filter(r => {
    if (query) {
      const haystack = `${r.employee} ${r.vendor} ${r.certificate}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (cert && r.certificate !== cert) return false;
    if (vendor && r.vendor !== vendor) return false;
    if (status && r.status !== status) return false;
    return true;
  });
}

function sortRecords(records) {
  return [...records].sort((a, b) => {
    const av = a[sortKey] || '';
    const bv = b[sortKey] || '';
    return av.localeCompare(bv) * sortDir;
  });
}

function render() {
  const filtered = sortRecords(getFiltered());
  renderSummary();
  renderTable(filtered);
}

// Summary cards always reflect the full dataset, independent of active filters.
function renderSummary() {
  const employees = new Set(allRecords.map(r => r.employee));
  const counts = { valid: 0, expiring_soon: 0, expired: 0, no_expiration: 0, unknown: 0 };
  for (const r of allRecords) counts[r.status] = (counts[r.status] || 0) + 1;

  const cards = [
    { label: 'Total employees', num: employees.size },
    { label: 'Total certifications', num: allRecords.length },
    { label: 'Expiring soon', num: counts.expiring_soon },
    { label: 'Expired', num: counts.expired },
  ];

  el('summary').innerHTML = cards.map(c => `
    <div class="card">
      <div class="num">${c.num}</div>
      <div class="label">${c.label}</div>
    </div>
  `).join('');
}

function renderTable(filtered) {
  const tbody = el('tbody');
  const emptyState = el('emptyState');

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td>${escapeHtml(r.employee)}</td>
      <td>${escapeHtml(r.vendor)}</td>
      <td>${escapeHtml(r.certificate)}</td>
      <td>${formatExpiration(r)}</td>
      <td><span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td>
    </tr>
  `).join('');
}

function formatExpiration(r) {
  if (r.expirationDate) return r.expirationDate;
  if (r.expirationText) return escapeHtml(r.expirationText);
  return '—';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setupSorting() {
  document.querySelectorAll('th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDir *= -1;
      } else {
        sortKey = key;
        sortDir = 1;
      }
      render();
    });
  });
}

function setupControls() {
  el('searchBox').addEventListener('input', render);
  ['filterCertificate', 'filterStatus'].forEach(id => el(id).addEventListener('change', render));
  el('filterVendor').addEventListener('change', (e) => {
    // Changing the vendor invalidates a previously-picked certificate from
    // a different vendor, so drop it back to "All certificates" and rescope
    // the dropdown to this vendor's certificates instead of showing 0 rows.
    el('filterCertificate').value = '';
    updateFilterCertificateOptionsForVendor(e.target.value);
    render();
  });
  el('clearFilters').addEventListener('click', () => {
    el('searchBox').value = '';
    el('filterVendor').value = '';
    el('filterCertificate').value = '';
    updateFilterCertificateOptionsForVendor('');
    el('filterStatus').value = '';
    render();
  });
}

function setupAddModal() {
  const modal = el('addModal');
  const form = el('addForm');
  const errorBox = el('addError');

  el('openAddModal').addEventListener('click', () => {
    form.reset();
    errorBox.hidden = true;
    fillDatalist('certificateOptions', allCertificates);
    modal.showModal();
  });

  el('cancelAdd').addEventListener('click', () => modal.close());

  // 'input' covers typing and picking a suggestion; 'change' covers a value
  // set programmatically (e.g. autofill) that doesn't fire 'input' in all browsers.
  ['input', 'change'].forEach((evt) => {
    el('addVendor').addEventListener(evt, (e) => {
      updateAddCertificateOptionsForVendor(e.target.value);
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;

    const payload = {
      employee: el('addEmployee').value.trim(),
      vendor: el('addVendor').value.trim(),
      certificate: el('addCertificate').value.trim(),
      expirationDate: el('addExpiration').value,
    };

    try {
      const res = await fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save this certification.');
      modal.close();
      await loadData();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });
}

setupSorting();
setupControls();
setupAddModal();
loadData();
