const STATUS_LABEL = {
  valid: 'Valid',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  no_expiration: 'No expiration',
  unknown: 'Unknown',
};

const APPROVAL_LABEL = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

let allRecords = [];
let allUsers = [];
let sortKey = 'employee';
let sortDir = 1;
let allCertificates = [];
let lowerVendorToCertificates = new Map(); // lowercase vendor -> sorted unique certificates seen under it

let authToken = localStorage.getItem('certToken');
let currentUser = null;
// Captured from the login form so the forced first-login reset doesn't have
// to ask the user to retype the temp password they just typed to log in.
// Stays null across a page reload (e.g. a stale mustResetPassword session),
// in which case the field falls back to asking for it directly.
let pendingResetPassword = null;

const el = (id) => document.getElementById(id);

// Wraps fetch with the bearer token and sends the user back to the login
// screen if the token is missing, expired, or otherwise rejected.
async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${authToken}` };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Your session expired — please log in again.');
  }
  return res;
}

function showScreen(id) {
  ['loginScreen', 'resetScreen', 'app'].forEach((s) => { el(s).hidden = s !== id; });
}

// Only show the "current password" field when we don't already have it in
// memory from the login form — the common case skips straight to just
// picking a new password.
function showResetScreen() {
  el('resetCurrentPasswordField').hidden = Boolean(pendingResetPassword);
  showScreen('resetScreen');
}

function logout() {
  authToken = null;
  currentUser = null;
  pendingResetPassword = null;
  localStorage.removeItem('certToken');
  el('loginForm').reset();
  showScreen('loginScreen');
}

function renderUserBox() {
  if (!currentUser) return;
  el('currentUserAvatar').innerHTML = avatarHtml(currentUser);
  el('currentUserLabel').textContent =
    `${currentUser.fullName} (${currentUser.role}${currentUser.department ? ' · ' + currentUser.department : ''})`;
  loadPendingAvatars();
}

function isAdmin() {
  return Boolean(currentUser && currentUser.role === 'admin');
}

async function enterApp() {
  showScreen('app');
  renderUserBox();
  // One class drives every .admin-only rule in the stylesheet.
  document.body.classList.toggle('is-admin', isAdmin());
  // Admins default to the approved view so the table looks as it always has;
  // employees see everything of theirs, pending and rejected included.
  el('filterApproval').value = isAdmin() ? 'approved' : '';
  showTab('certificates');
  if (!isAdmin()) renderProfileCard(el('homeProfileCard'), currentUser);
  await loadData();
  if (isAdmin()) await loadUsers();
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
  ['certificates', 'pending', 'users', 'profile'].forEach((t) => {
    el(`tab-${t}`).hidden = t !== name;
  });
  if (name === 'profile') loadProfile();
}

async function init() {
  if (!authToken) return showScreen('loginScreen');

  try {
    const res = await authFetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const { user } = await res.json();
    currentUser = user;
    if (user.mustResetPassword) {
      // A reload here means we don't have the plaintext password in memory
      // any more, so the field has to ask for it again.
      pendingResetPassword = null;
      showResetScreen();
    } else {
      await enterApp();
    }
  } catch {
    logout();
  }
}

function setupAuthForms() {
  el('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = el('loginError');
    errorBox.hidden = true;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: el('loginEmail').value.trim(),
          password: el('loginPassword').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed.');

      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('certToken', authToken);

      if (currentUser.mustResetPassword) {
        pendingResetPassword = el('loginPassword').value;
        el('resetForm').reset();
        showResetScreen();
      } else {
        await enterApp();
      }
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });

  el('resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = el('resetError');
    errorBox.hidden = true;

    const newPassword = el('resetNewPassword').value;
    const confirmPassword = el('resetConfirmPassword').value;
    if (newPassword !== confirmPassword) {
      errorBox.textContent = 'Passwords do not match.';
      errorBox.hidden = false;
      return;
    }

    const currentPassword = pendingResetPassword || el('resetCurrentPassword').value;
    if (!currentPassword) {
      errorBox.textContent = 'Enter your current password.';
      errorBox.hidden = false;
      return;
    }

    try {
      const res = await authFetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not set the new password.');

      pendingResetPassword = null;
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('certToken', authToken);
      await enterApp();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });

  el('logoutBtn').addEventListener('click', logout);
}

async function loadData() {
  const res = await authFetch('/api/certificates');
  const data = await res.json();
  allRecords = data.records || [];
  populateFilterOptions();
  render();
}

function populateFilterOptions() {
  const vendors = uniqueSorted(allRecords.map(r => r.vendor));
  const certificates = uniqueSorted(allRecords.map(r => r.certificate));

  fillSelect('filterVendor', vendors);

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

function getFiltered() {
  const query = el('searchBox').value.trim().toLowerCase();
  const cert = el('filterCertificate').value;
  const vendor = el('filterVendor').value;
  const status = el('filterStatus').value;
  const approval = el('filterApproval').value;

  return allRecords.filter(r => {
    if (query) {
      const haystack = `${r.employee} ${r.vendor} ${r.certificate}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (cert && r.certificate !== cert) return false;
    if (vendor && r.vendor !== vendor) return false;
    if (status && r.status !== status) return false;
    if (approval && r.approvalStatus !== approval) return false;
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
  if (isAdmin()) renderPendingTab();
}

function formatRequestedAt(r) {
  return r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—';
}

function renderPendingTab() {
  const pending = allRecords.filter(r => r.approvalStatus === 'pending');
  const badge = el('pendingCount');
  badge.textContent = String(pending.length);
  badge.hidden = pending.length === 0;

  const tbody = el('pendingTbody');
  const emptyState = el('pendingEmptyState');
  if (pending.length === 0) {
    tbody.innerHTML = '';
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  tbody.innerHTML = pending.map(r => `
    <tr>
      <td>${escapeHtml(r.employee)}</td>
      <td>${escapeHtml(r.vendor)}</td>
      <td>${escapeHtml(r.certificate)}</td>
      <td>${formatExpiration(r)}</td>
      <td>${formatRequestedAt(r)}</td>
      <td><div class="row-actions">
        <button class="approve" data-action="approve" data-id="${r.id}">Approve</button>
        <button data-action="reject" data-id="${r.id}">Reject</button>
        <span class="action-divider"></span>
        <button class="danger" data-action="delete-cert" data-id="${r.id}">Delete</button>
      </div></td>
    </tr>
  `).join('');
}

// Summary cards always reflect the full dataset, independent of active filters.
function renderSummary() {
  // Counts cover approved certifications only — a pending request isn't a
  // certification yet, and shouldn't inflate the totals.
  const approved = allRecords.filter(r => r.approvalStatus === 'approved');
  const employees = new Set(approved.map(r => r.employee));
  const counts = { valid: 0, expiring_soon: 0, expired: 0, no_expiration: 0, unknown: 0 };
  for (const r of approved) counts[r.status] = (counts[r.status] || 0) + 1;

  const cards = [
    { label: 'Total employees', num: employees.size },
    { label: 'Total certifications', num: approved.length },
    { label: 'Expiring soon', num: counts.expiring_soon },
    { label: 'Expired', num: counts.expired },
  ];
  if (isAdmin()) {
    cards.push({ label: 'Pending requests', num: allRecords.filter(r => r.approvalStatus === 'pending').length });
  }

  el('summary').innerHTML = cards.map(c => `
    <div class="card">
      <div class="num">${c.num}</div>
      <div class="label">${c.label}</div>
    </div>
  `).join('');
}

function approvalBadge(r) {
  const badge = `<span class="badge approval-${r.approvalStatus}">${APPROVAL_LABEL[r.approvalStatus] || r.approvalStatus}</span>`;
  if (r.approvalStatus !== 'rejected' || !r.rejectionReason) return badge;
  // Shown as real text, not a title="" tooltip — hover never reaches touch
  // users, and a plain badge gives no hint there's more to see anyway.
  // title="" stays too, as a free desktop-hover bonus.
  const reason = escapeHtml(r.rejectionReason);
  return `${badge}<div class="rejection-reason" tabindex="0" role="button" aria-label="Rejection reason (click to expand)" title="${reason}">${reason}</div>`;
}

function rowActions(r) {
  if (!isAdmin()) return '';
  const review = r.approvalStatus === 'pending'
    ? `<button class="approve" data-action="approve" data-id="${r.id}">Approve</button>
       <button data-action="reject" data-id="${r.id}">Reject</button>
       <span class="action-divider"></span>`
    : '';
  return `<td class="admin-only"><div class="row-actions">${review}
      <button class="danger" data-action="delete-cert" data-id="${r.id}">Delete</button>
    </div></td>`;
}

// Every row is the viewer's own for an employee, so restating their name in
// every row is just noise — omitted entirely to match the hidden header
// (Actions works the same way, above).
function employeeCell(r) {
  return isAdmin() ? `<td>${escapeHtml(r.employee)}</td>` : '';
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
      ${employeeCell(r)}
      <td>${escapeHtml(r.vendor)}</td>
      <td>${escapeHtml(r.certificate)}</td>
      <td>${formatExpiration(r)}</td>
      <td><span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td>
      <td>${approvalBadge(r)}</td>
      ${rowActions(r)}
    </tr>
  `).join('');
}

function formatExpiration(r) {
  if (r.expirationDate) return r.expirationDate;
  if (r.expirationText) return escapeHtml(r.expirationText);
  return '—';
}

// Quotes matter as much as angle brackets here: rejection reasons are free
// admin-authored text and get interpolated into a title="..." attribute.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateSortIndicators() {
  document.querySelectorAll('th[data-key]').forEach(th => {
    const active = th.dataset.key === sortKey;
    th.classList.toggle('sorted-asc', active && sortDir === 1);
    th.classList.toggle('sorted-desc', active && sortDir === -1);
    th.setAttribute('aria-sort', active ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
  });
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
      updateSortIndicators();
      render();
    });
  });
  updateSortIndicators();
}

// One document-level listener covers every table that can render a
// rejection reason (certificates, profile, admin's view-profile modal)
// instead of wiring up each tbody separately.
function setupRejectionReasonToggle() {
  document.addEventListener('click', (e) => {
    const reason = e.target.closest('.rejection-reason');
    if (reason) reason.classList.toggle('expanded');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target.classList || !e.target.classList.contains('rejection-reason')) return;
    e.preventDefault();
    e.target.classList.toggle('expanded');
  });
}

function setupControls() {
  el('searchBox').addEventListener('input', render);
  ['filterCertificate', 'filterStatus', 'filterApproval'].forEach(id => el(id).addEventListener('change', render));
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
    el('filterApproval').value = '';
    render();
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });
}

// Live-search combobox: filters `getOptions()` as the user types, and (when
// nothing matches at all) offers "+ Add '<text>' as new" so a genuinely new
// vendor/certificate is always reachable without a separate mode switch.
// Whatever ends up in the input — typed or picked — is the value on submit,
// so callers don't need to track "was this newly typed or selected."
function setupCombobox({ inputId, listId, flagId, getOptions, onCommit }) {
  const input = el(inputId);
  const list = el(listId);
  const flag = flagId ? el(flagId) : null;
  let activeIndex = -1;
  // Tracks the last value this field actually settled on (picked or typed
  // then left), so `onCommit` fires once per real change — not on every
  // keystroke, which previously cleared the certificate field mid-typing.
  let lastCommitted = input.value.trim();

  function matches(query) {
    const options = getOptions();
    return query ? options.filter(o => o.toLowerCase().includes(query.toLowerCase())) : options;
  }

  function updateFlag(value) {
    if (!flag) return;
    const exists = getOptions().some(o => o.toLowerCase() === value.toLowerCase());
    flag.hidden = !(value.length > 0 && !exists);
  }

  function render() {
    const query = input.value.trim();
    const found = matches(query);
    const items = found.map(o => `<li role="option" data-value="${escapeHtml(o)}">${escapeHtml(o)}</li>`);
    // "Add as new" only when nothing at all matches — while "Palo Alto" is
    // still showing for a query of "pal", the user is narrowing down an
    // existing entry, not proposing a new one.
    if (query && found.length === 0) {
      items.push(`<li role="option" class="combobox-new" data-value="${escapeHtml(query)}">+ Add "${escapeHtml(query)}" as new</li>`);
    }
    list.innerHTML = items.join('');
    // Only ever pop *this* list open for the field the user is actually in.
    // `refresh()` gets called on other comboboxes too (e.g. re-scoping
    // Certificate's options as Vendor changes) — without this check that
    // recompute was popping the Certificate list open while the user was
    // still typing in Vendor, with no relation to what they'd clicked.
    const isFocused = document.activeElement === input;
    list.hidden = !isFocused || items.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    activeIndex = -1;
    updateFlag(query);
  }

  function setActive(index) {
    const items = [...list.children];
    activeIndex = index;
    items.forEach((li, i) => li.classList.toggle('active', i === activeIndex));
    if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function commitIfChanged() {
    const value = input.value.trim();
    if (value === lastCommitted) return;
    lastCommitted = value;
    if (onCommit) onCommit(value);
  }

  function choose(value) {
    input.value = value;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    updateFlag(value);
    commitIfChanged();
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  // A plain 'click' on the <li> would fire after 'blur' already hid the
  // list, so this has to be 'mousedown', which fires first. preventDefault
  // stops the browser's default mousedown behavior of blurring the input
  // (the <li> itself isn't focusable) — without it, every pick briefly
  // blurred and refocused the field for no reason.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    choose(li.dataset.value);
  });
  input.addEventListener('blur', () => {
    commitIfChanged();
    // Guarded by a re-check, not just a delay: without it, a blur that's
    // immediately followed by a refocus (e.g. clicking back in, or a fast
    // tab-away-and-back) leaves a stale timer that hides the list again a
    // moment later even though the user is back in the field typing.
    setTimeout(() => {
      if (document.activeElement !== input) {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      }
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    const items = [...list.children];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) return render();
      setActive(Math.min(activeIndex + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter' && !list.hidden && items[activeIndex]) {
      e.preventDefault();
      choose(items[activeIndex].dataset.value);
    } else if (e.key === 'Escape' && !list.hidden) {
      // Dismiss just the suggestion list. Without stopping this, Escape
      // also bubbles to the <dialog>'s native cancel behavior and closes
      // the entire modal — wiping out everything else typed in the form.
      e.preventDefault();
      e.stopPropagation();
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });

  return {
    refresh: render,
    reset: (value = '') => { input.value = value; lastCommitted = value; updateFlag(value); },
  };
}

function setupAddModal() {
  const modal = el('addModal');
  const form = el('addForm');
  const errorBox = el('addError');
  const submitBtn = el('submitAdd');

  const certificateCombobox = setupCombobox({
    inputId: 'addCertificate',
    listId: 'addCertificateList',
    flagId: 'addCertificateFlag',
    // Scoped to whatever vendor is currently typed, same as the filter
    // dropdown — a brand-new vendor naturally has no certificates yet.
    // Reads el('addVendor').value live, so it's always in sync without
    // Vendor needing to explicitly push updates into this combobox.
    getOptions: () => {
      const key = el('addVendor').value.trim().toLowerCase();
      return (key && lowerVendorToCertificates.get(key)) || allCertificates;
    },
  });
  const vendorCombobox = setupCombobox({
    inputId: 'addVendor',
    listId: 'addVendorList',
    flagId: 'addVendorFlag',
    getOptions: () => uniqueSorted(allRecords.map(r => r.vendor)),
    // A certificate picked under a different vendor no longer applies —
    // but only clear it once the vendor change actually settles (a click,
    // an Enter, or tabbing away), not on every keystroke while typing.
    onCommit: () => { certificateCombobox.reset(''); },
  });

  el('openAddModal').addEventListener('click', () => {
    form.reset();
    errorBox.hidden = true;
    vendorCombobox.reset('');
    certificateCombobox.reset('');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save';

    // Admins pick a real user; employees can only ever file a request for
    // themselves, which the server enforces regardless of what's sent.
    el('addSelfNote').hidden = isAdmin();
    if (isAdmin()) {
      el('addUserId').innerHTML = allUsers
        .map(u => `<option value="${u.id}">${escapeHtml(u.fullName)}</option>`)
        .join('');
    }

    modal.showModal();
  });

  el('cancelAdd').addEventListener('click', () => modal.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;

    const vendor = el('addVendor').value.trim();
    const certificate = el('addCertificate').value.trim();

    if (!vendor) {
      errorBox.textContent = 'Type or pick a vendor.';
      errorBox.hidden = false;
      return;
    }
    if (!certificate) {
      errorBox.textContent = 'Type or pick a certificate.';
      errorBox.hidden = false;
      return;
    }

    const payload = { vendor, certificate, expirationDate: el('addExpiration').value };
    // Admins post to the admin route with an explicit owner; an employee's
    // own request goes to the shared route and is always for themselves.
    const url = isAdmin() ? '/api/admin/certificates' : '/api/certificates';
    if (isAdmin()) payload.userId = Number(el('addUserId').value);

    // Guards against a double-submit from an impatient double click, and
    // gives feedback for the moment the request is actually in flight.
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
      const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save this certification.');
      // Refresh before closing, not after — otherwise there's a window where
      // the modal is gone but the table still shows the pre-submit state.
      await refreshAll();
      modal.close();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
    }
  });
}

// Styled replacement for window.confirm(), used for every destructive
// action. `requireText`, when set, disables the confirm button until the
// user types it exactly — reserved for the highest-blast-radius actions
// (deleting a user cascades to all their certificates) so a fast double
// click can't do it by accident the way a single OK button can.
function confirmDialog({ title, message, confirmLabel = 'Delete', requireText = null }) {
  return new Promise((resolve) => {
    const modal = el('confirmModal');
    const okBtn = el('confirmOk');
    const cancelBtn = el('confirmCancel');
    const typeField = el('confirmTypeField');
    const typeInput = el('confirmTypeInput');

    el('confirmTitle').textContent = title;
    el('confirmMessage').textContent = message;
    okBtn.textContent = confirmLabel;
    typeInput.value = '';
    typeField.hidden = !requireText;
    if (requireText) el('confirmTypeTarget').textContent = requireText;
    okBtn.disabled = Boolean(requireText);

    const onInput = () => {
      okBtn.disabled = Boolean(requireText) && typeInput.value.trim() !== requireText;
    };
    const finish = (result) => {
      typeInput.removeEventListener('input', onInput);
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      modal.removeEventListener('close', onDialogClose);
      modal.close();
      resolve(result);
    };
    const onCancel = () => finish(false);
    const onOk = () => finish(true);
    // Fires on Esc, which skips the button handlers above entirely.
    const onDialogClose = () => resolve(false);

    typeInput.addEventListener('input', onInput);
    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    modal.addEventListener('close', onDialogClose, { once: true });
    modal.showModal();
  });
}

async function refreshAll() {
  await loadData();
  if (isAdmin()) await loadUsers();
}

/* ------------------------------------------------- admin: certificates --- */

function setupRowActions() {
  // One delegated listener per tbody: each is replaced wholesale on every
  // render, so per-row handlers would be re-attached (and leaked) each time.
  // Certificates and Pending share the same actions, so both tbodies use
  // the same handler.
  const onClick = async (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;

    const id = Number(button.dataset.id);
    const action = button.dataset.action;

    if (action === 'reject') return openRejectModal(id);
    if (action === 'approve') return approveCert(id);
    if (action === 'delete-cert') {
      const record = allRecords.find(r => r.id === id);
      const ok = await confirmDialog({
        title: 'Delete certification?',
        message: `Delete "${record.certificate}" from ${record.employee}? This can't be undone.`,
      });
      if (!ok) return;
      return deleteCert(id);
    }
  };
  el('tbody').addEventListener('click', onClick);
  el('pendingTbody').addEventListener('click', onClick);
}

async function adminAction(url, options = {}) {
  const res = await authFetch(url, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || 'That action failed.');
    return false;
  }
  await refreshAll();
  return true;
}

function approveCert(id) {
  return adminAction(`/api/admin/certificates/${id}/approve`, { method: 'POST' });
}

function deleteCert(id) {
  return adminAction(`/api/admin/certificates/${id}`, { method: 'DELETE' });
}

function openRejectModal(id) {
  const record = allRecords.find(r => r.id === id);
  const modal = el('rejectModal');
  el('rejectForm').reset();
  el('rejectError').hidden = true;
  el('rejectSummary').textContent = `${record.employee} — ${record.vendor} ${record.certificate}`;
  modal.dataset.certId = String(id);
  modal.showModal();
}

function setupRejectModal() {
  const modal = el('rejectModal');
  el('cancelReject').addEventListener('click', () => modal.close());

  el('rejectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = el('rejectError');
    errorBox.hidden = true;

    const reason = el('rejectReason').value.trim();
    if (!reason) {
      errorBox.textContent = 'A reason is required.';
      errorBox.hidden = false;
      return;
    }

    const res = await authFetch(`/api/admin/certificates/${modal.dataset.certId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorBox.textContent = data.error || 'Could not reject this request.';
      errorBox.hidden = false;
      return;
    }
    await refreshAll();
    modal.close();
  });
}

/* --------------------------------------------------------- admin: users --- */

async function loadUsers() {
  const res = await authFetch('/api/admin/users');
  const data = await res.json();
  allUsers = data.users || [];
  renderUsersTable();
}

// Photo bytes live behind an authenticated route, and a plain <img src> can't
// carry an Authorization header — so a photo can't be linked to directly. It
// has to be fetched like any other protected data and swapped in afterwards.
const photoUrlCache = new Map(); // userId -> object URL, cached for the session (photos aren't editable, so it never goes stale)

function avatarHtml(user) {
  if (!user.hasProfilePhoto) {
    const initials = (user.fullName || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
    return `<div class="avatar-placeholder">${escapeHtml(initials)}</div>`;
  }
  const cached = photoUrlCache.get(user.id);
  if (cached) return `<img class="avatar" src="${cached}" alt="" />`;
  return `<div class="avatar-placeholder" data-avatar-pending="${user.id}"></div>`;
}

// Fills in every placeholder left by avatarHtml() once the actual bytes are
// fetched. Call this after any innerHTML assignment that used avatarHtml().
async function loadPendingAvatars() {
  const nodes = [...document.querySelectorAll('[data-avatar-pending]')];
  await Promise.all(nodes.map(async (node) => {
    const id = node.dataset.avatarPending;
    try {
      const res = await authFetch(`/api/users/${id}/photo`);
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      photoUrlCache.set(Number(id), url);
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = '';
      img.src = url;
      node.replaceWith(img);
    } catch {
      // Leave the initials placeholder rather than a broken image.
    }
  }));
}

function renderUsersTable() {
  el('usersTbody').innerHTML = allUsers.map(u => `
    <tr>
      <td>${avatarHtml(u)}</td>
      <td>${escapeHtml(u.fullName)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.department || '—')}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.certCounts.approved} approved${u.certCounts.pending ? ` · ${u.certCounts.pending} pending` : ''}</td>
      <td><div class="row-actions">
        <button data-action="view-user" data-id="${u.id}">View</button>
        <button data-action="edit-user" data-id="${u.id}">Edit</button>
        <span class="action-divider"></span>
        <button class="danger" data-action="delete-user" data-id="${u.id}">Delete</button>
      </div></td>
    </tr>
  `).join('');
  loadPendingAvatars();
}

function setupUsersTab() {
  el('usersTbody').addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;

    const id = Number(button.dataset.id);
    const user = allUsers.find(u => u.id === id);

    if (button.dataset.action === 'view-user') return openUserProfilePage(user);
    if (button.dataset.action === 'edit-user') return openUserModal(user);
    if (button.dataset.action === 'delete-user') {
      const ok = await confirmDialog({
        title: 'Delete user?',
        message: `This permanently deletes ${user.fullName} and every certificate on their record.`,
        confirmLabel: 'Delete user',
        requireText: user.fullName,
      });
      if (!ok) return;
      await adminAction(`/api/admin/users/${id}`, { method: 'DELETE' });
    }
  });

  el('openUserModal').addEventListener('click', () => openUserModal(null));
  el('cancelUser').addEventListener('click', () => el('userModal').close());

  // After a successful creation the submit button turns into "OK" (see the
  // submit handler below) and just dismisses the modal instead of
  // re-submitting the form — type="button" means this fires without a submit event.
  el('submitUser').addEventListener('click', () => {
    if (el('submitUser').type === 'button') el('userModal').close();
  });

  // Live preview of the chosen file, without waiting on a round trip.
  el('userPhoto').addEventListener('change', () => {
    const file = el('userPhoto').files[0];
    const preview = el('userPhotoPreview');
    if (!file) {
      preview.hidden = true;
      preview.removeAttribute('src');
      return;
    }
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
  });

  el('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const modal = el('userModal');
    const errorBox = el('userError');
    errorBox.hidden = true;

    const editingId = modal.dataset.userId;
    const fullName = el('userFullName').value.trim();
    const email = el('userEmail').value.trim().toLowerCase();
    const department = el('userDepartment').value.trim() || null;
    const role = el('userRole').value;

    let res;
    if (editingId) {
      // Photo upload is only offered at creation time; editing stays plain JSON.
      res = await authFetch(`/api/admin/users/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, email, department, role }),
      });
    } else {
      // multipart/form-data so the photo file can ride along with the other
      // fields — no Content-Type header here, fetch sets the boundary itself.
      const formData = new FormData();
      formData.append('fullName', fullName);
      formData.append('email', email);
      if (department) formData.append('department', department);
      formData.append('role', role);
      const photoFile = el('userPhoto').files[0];
      if (photoFile) formData.append('photo', photoFile);
      res = await authFetch('/api/admin/users', { method: 'POST', body: formData });
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorBox.textContent = data.error || 'Could not save this user.';
      errorBox.hidden = false;
      return;
    }

    await refreshAll();
    if (data.tempPassword) {
      // Shown once — there's no email delivery, so the admin has to relay it.
      el('userTempPassword').textContent =
        `Temporary password for ${email}: ${data.tempPassword} — they must change it on first login.`;
      el('userTempPassword').hidden = false;

      // Nothing left to edit — Save becomes OK and just closes the modal.
      el('submitUser').textContent = 'OK';
      el('submitUser').type = 'button';
      el('cancelUser').hidden = true;
    } else {
      modal.close();
    }
  });
}

function openUserModal(user) {
  const modal = el('userModal');
  el('userForm').reset();
  el('userError').hidden = true;
  el('userTempPassword').hidden = true;
  el('userPhotoPreview').hidden = true;
  el('userPhotoPreview').removeAttribute('src');
  el('submitUser').textContent = 'Save';
  el('submitUser').type = 'submit';
  el('cancelUser').hidden = false;
  // Uploading applies only when creating a user, not editing one.
  el('userPhotoField').hidden = Boolean(user);

  if (user) {
    modal.dataset.userId = String(user.id);
    el('userModalTitle').textContent = 'Edit user';
    el('userFullName').value = user.fullName;
    el('userEmail').value = user.email;
    el('userDepartment').value = user.department || '';
    el('userRole').value = user.role;
  } else {
    delete modal.dataset.userId;
    el('userModalTitle').textContent = 'Add user';
  }
  modal.showModal();
}

/* ------------------------------------------------------------- profile --- */

// Shared by "My profile", the admin's "View" modal, and the employee home
// page — same card, just a different user and a different element to fill.
function renderProfileCard(cardEl, user) {
  const fields = [
    ['Photo', avatarHtml(user)],
    ['Name', escapeHtml(user.fullName)],
    ['Email', escapeHtml(user.email)],
    ['Department', escapeHtml(user.department || '—')],
    ['Role', escapeHtml(user.role)],
  ];
  cardEl.innerHTML = fields.map(([label, value]) => `
    <div>
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
  `).join('');
  loadPendingAvatars();
}

function renderProfileInto(cardEl, tbodyEl, user, records) {
  renderProfileCard(cardEl, user);

  tbodyEl.innerHTML = records.length === 0
    ? '<tr><td colspan="5" class="empty-state">No certifications yet.</td></tr>'
    : records.map(r => `
      <tr>
        <td>${escapeHtml(r.vendor)}</td>
        <td>${escapeHtml(r.certificate)}</td>
        <td>${formatExpiration(r)}</td>
        <td><span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td>
        <td>${approvalBadge(r)}</td>
      </tr>
    `).join('');
}

async function loadProfile() {
  const res = await authFetch('/api/auth/me');
  const { user } = await res.json();
  currentUser = user;
  renderProfileInto(el('profileCard'), el('profileTbody'), user, allRecords.filter(r => r.userId === user.id));
}

// Admin-only: a full page for one user's profile + certificates, rendered
// exactly like that employee's own home page (same renderProfileInto used
// by "My profile") — a real page with a Back button instead of a popup, so
// it reads as "here is their view," not "here is a dialog about them."
// No extra request needed — GET /api/certificates already returned
// everyone's records to an admin.
function openUserProfilePage(user) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  ['certificates', 'pending', 'users', 'profile'].forEach((t) => { el(`tab-${t}`).hidden = true; });
  el('tabsNav').hidden = true;
  el('tab-viewUser').hidden = false;
  el('viewUserHeading').textContent = `${user.fullName}'s certifications`;
  renderProfileInto(el('viewUserProfileCard'), el('viewUserTbody'), user, allRecords.filter(r => r.userId === user.id));
  window.scrollTo(0, 0);
}

function closeUserProfilePage() {
  el('tab-viewUser').hidden = true;
  el('tabsNav').hidden = false;
  showTab('users');
}

function setupUserProfilePage() {
  el('backFromViewUser').addEventListener('click', closeUserProfilePage);
}

// Every <dialog> in the app closes on a click outside its content — the
// click lands on the ::backdrop, which browsers report as a click whose
// target is the <dialog> element itself (nothing inside it was hit).
function setupDialogBackdropClose() {
  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  });
}

setupAuthForms();
setupSorting();
setupControls();
setupAddModal();
setupRowActions();
setupRejectModal();
setupUsersTab();
setupUserProfilePage();
setupRejectionReasonToggle();
setupDialogBackdropClose();
init();
