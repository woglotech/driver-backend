/* ═══════════════════════════════════════════════════════════════════════════
   Woglo Driver Admin Panel — app.js
   All event listeners attached via addEventListener (no inline handlers)
═══════════════════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────────────
let API_URL = '';
let TOKEN   = '';
let currentFilter  = 'pending';
let rejectTargetId = null;             // driverId for overall reject modal
let docRejectDriverId = null;          // driverId for doc reject modal
let docRejectKycId = null;             // kycId for doc reject modal
const driverDetailCache = {};          // driverId -> { driver, kycDocs }
const docStore = {};                   // kycId -> { fileUrlFront, fileUrlBack }

// ── DOM refs ───────────────────────────────────────────────────────────────
const loginScreen   = document.getElementById('login-screen');
const appScreen     = document.getElementById('app-screen');
const loginBtn      = document.getElementById('login-btn');
const loginBtnText  = document.getElementById('login-btn-text');
const loginError    = document.getElementById('login-error');
const logoutBtn     = document.getElementById('logout-btn');
const refreshBtn    = document.getElementById('refresh-btn');
const rejectModal   = document.getElementById('reject-modal');
const cancelReject  = document.getElementById('cancel-reject-btn');
const confirmReject = document.getElementById('confirm-reject-btn');

const docRejectModal   = document.getElementById('doc-reject-modal');
const cancelDocReject  = document.getElementById('cancel-doc-reject-btn');
const confirmDocReject = document.getElementById('confirm-doc-reject-btn');

const lightbox      = document.getElementById('lightbox');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxImg   = document.getElementById('lightbox-img');
const lightboxLabel = document.getElementById('lightbox-label');
const toast         = document.getElementById('toast');
const driverList     = document.getElementById('driver-list-container');

// ── Auth ───────────────────────────────────────────────────────────────────
loginBtn.addEventListener('click', doLogin);
document.getElementById('admin-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
logoutBtn.addEventListener('click', doLogout);

async function doLogin() {
  const url   = document.getElementById('api-url').value.trim().replace(/\/$/, '');
  const email = document.getElementById('admin-email').value.trim();
  const pass  = document.getElementById('admin-password').value;

  loginError.style.display = 'none';
  loginBtnText.textContent = 'Signing in…';
  loginBtn.disabled = true;

  try {
    const res  = await fetch(`${url}/api/v1/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    API_URL = url;
    TOKEN   = data.token;

    document.getElementById('admin-email-display').textContent = data.admin?.email || email;
    loginScreen.style.display = 'none';
    appScreen.style.display   = 'block';

    loadStats();
    loadDrivers();
  } catch (err) {
    loginError.textContent    = err.message;
    loginError.style.display  = 'block';
  } finally {
    loginBtnText.textContent = 'Sign In';
    loginBtn.disabled = false;
  }
}

function doLogout() {
  TOKEN = ''; API_URL = '';
  appScreen.style.display   = 'none';
  loginScreen.style.display = 'flex';
  document.getElementById('admin-password').value = '';
}

// ── API helper ─────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res  = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Filter tabs & stats cards ──────────────────────────────────────────────
document.querySelectorAll('#drivers-section .filter-tab').forEach(tab => {
  tab.addEventListener('click', () => setFilter(tab.dataset.filter));
});
document.querySelectorAll('#drivers-section .stat-card').forEach(card => {
  card.addEventListener('click', () => setFilter(card.dataset.filter));
});
refreshBtn.addEventListener('click', loadDrivers);

function setFilter(filter) {
  currentFilter = filter;

  document.querySelectorAll('#drivers-section .stat-card').forEach(c => c.classList.remove('ring'));
  const sc = document.getElementById(`stat-${filter}`);
  if (sc) sc.classList.add('ring');

  document.querySelectorAll('#drivers-section .filter-tab').forEach(t => delete t.dataset.active);
  const activeTab = document.querySelector(`#drivers-section .filter-tab[data-filter="${filter || 'all'}"]`);
  if (activeTab) activeTab.dataset.active = filter || 'all';

  loadDrivers();
}

// ── Data loading ───────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const [p, v, r] = await Promise.all([
      apiFetch('/api/v1/admin/drivers?kycStatus=pending&limit=1'),
      apiFetch('/api/v1/admin/drivers?kycStatus=approved&limit=1'),
      apiFetch('/api/v1/admin/drivers?kycStatus=rejected&limit=1'),
    ]);
    document.getElementById('count-pending').textContent  = p.total ?? '?';
    document.getElementById('count-approved').textContent = v.total ?? '?';
    document.getElementById('count-rejected').textContent = r.total ?? '?';
  } catch (_) { /* silent */ }
}

async function loadDrivers() {
  driverList.innerHTML = '<div class="loading-state"><div class="spinner"></div><div>Loading drivers…</div></div>';
  const qs = currentFilter ? `?kycStatus=${currentFilter}&limit=50` : '?limit=50';
  try {
    const data = await apiFetch(`/api/v1/admin/drivers${qs}`);
    renderDrivers(data.data || []);
  } catch (err) {
    driverList.innerHTML = `<div class="empty-state"><div class="emoji">⚠️</div>${escHtml(err.message)}</div>`;
  }
}

// ── Render (list level — docs are lazy-loaded on expand) ──────────────────
function renderDrivers(drivers) {
  if (!drivers.length) {
    driverList.innerHTML = '<div class="empty-state"><div class="emoji">🎉</div>No drivers in this category</div>';
    return;
  }
  driverList.innerHTML = `<div class="vendor-list">${drivers.map(buildCard).join('')}</div>`;

  drivers.forEach(d => {
    const id = d._id;
    const header = document.querySelector(`#vc-${id} .vendor-header`);
    if (header) header.addEventListener('click', () => toggleCard(id));
  });
}

function buildCard(d) {
  const id      = d._id;
  const name    = d.name || 'Unnamed Driver';
  const email   = d.email || '—';
  const phone   = d.phone || '—';
  const kyc     = d.kycStatus || 'pending';

  const avatar = d.profilePicture
    ? `<img src="${d.profilePicture}" alt="Profile"/>`
    : `<span>${escHtml(name.charAt(0).toUpperCase())}</span>`;

  return `
    <div class="vendor-card" id="vc-${id}">
      <div class="vendor-header">
        <div class="vendor-avatar">${avatar}</div>
        <div class="vendor-info">
          <div class="vendor-name">${escHtml(name)}</div>
          <div class="vendor-meta">${escHtml(email)} · ${escHtml(phone)} · <strong>${escHtml(d.driverId || '—')}</strong></div>
        </div>
        <span class="status-badge ${kyc}">${kyc.toUpperCase()}</span>
        <span class="expand-arrow">▾</span>
      </div>
      <div class="vendor-detail" id="vd-${id}">
        <div class="loading-state"><div class="spinner"></div><div>Loading details…</div></div>
      </div>
    </div>`;
}

async function toggleCard(driverId) {
  const card = document.getElementById(`vc-${driverId}`);
  if (!card) return;
  const wasExpanded = card.classList.contains('expanded');
  card.classList.toggle('expanded');
  if (wasExpanded) return; // collapsing — nothing else to do

  if (!driverDetailCache[driverId]) {
    try {
      const res = await apiFetch(`/api/v1/admin/drivers/${driverId}`);
      driverDetailCache[driverId] = res.data;
      (res.data.kycDocs || []).forEach(k => { docStore[k._id] = k; });
    } catch (err) {
      document.getElementById(`vd-${driverId}`).innerHTML =
        `<div class="empty-state"><div class="emoji">⚠️</div>${escHtml(err.message)}</div>`;
      return;
    }
  }

  renderDriverDetail(driverId);
}

function renderDriverDetail(driverId) {
  const { driver, kycDocs } = driverDetailCache[driverId];
  const detailEl = document.getElementById(`vd-${driverId}`);
  const kyc = driver.kycStatus || 'pending';
  const addr = driver.address || {};
  const license = driver.license || {};

  const rejectRow = driver.kycRejectionReason
    ? `<div class="info-row"><span class="info-key">Rejection Reason</span><span class="info-val" style="color:var(--red)">${escHtml(driver.kycRejectionReason)}</span></div>`
    : '';

  const joined = driver.createdAt
    ? new Date(driver.createdAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })
    : '—';

  detailEl.innerHTML = `
    <div class="detail-grid">
      <div class="detail-section">
        <div class="section-title">Driver Info</div>
        <div class="info-row"><span class="info-key">DOB</span><span class="info-val">${driver.dob ? new Date(driver.dob).toLocaleDateString('en-IN') : '—'}</span></div>
        <div class="info-row"><span class="info-key">Address</span><span class="info-val">${escHtml([addr.line1, addr.city, addr.state, addr.country, addr.pinCode].filter(Boolean).join(', ') || '—')}</span></div>
        <div class="info-row"><span class="info-key">License No.</span><span class="info-val">${escHtml(license.number || '—')}</span></div>
        <div class="info-row"><span class="info-key">License Valid Till</span><span class="info-val">${escHtml(license.validTill || '—')}</span></div>
        <div class="info-row"><span class="info-key">License Types</span><span class="info-val">${escHtml((license.types || []).join(', ') || '—')}</span></div>
        ${rejectRow}
      </div>
      <div class="detail-section">
        <div class="section-title">Verification Status</div>
        <div class="info-row"><span class="info-key">KYC Status</span><span class="info-val"><span class="status-badge ${kyc}">${kyc.toUpperCase()}</span></span></div>
        <div class="info-row"><span class="info-key">Documents</span><span class="info-val">${kycDocs.length} file(s)</span></div>
        <div class="info-row"><span class="info-key">Rating</span><span class="info-val">${driver.rating || 0}</span></div>
        <div class="info-row"><span class="info-key">Joined</span><span class="info-val">${joined}</span></div>
      </div>
    </div>

    <div class="docs-section">
      <div class="section-title">📄 Submitted KYC Documents (${kycDocs.length})</div>
      ${buildDocGrid(driverId, kycDocs)}
    </div>

    <div class="action-bar">
      <div class="action-buttons">
        <button class="btn btn-approve btn-sm approve-btn">✅ Approve Driver</button>
        <button class="btn btn-reject  btn-sm reject-btn">❌ Reject Driver</button>
      </div>
    </div>
  `;

  const approveBtn = detailEl.querySelector('.approve-btn');
  if (approveBtn) approveBtn.addEventListener('click', (e) => { e.stopPropagation(); approveDriver(driverId); });
  const rejectBtn = detailEl.querySelector('.reject-btn');
  if (rejectBtn) rejectBtn.addEventListener('click', (e) => { e.stopPropagation(); openRejectModal(driverId); });

  detailEl.querySelectorAll('.doc-card').forEach(card => {
    const kycId = card.dataset.kycId;
    const side  = card.dataset.side;
    const type  = card.dataset.docType;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.doc-action-bar')) return;
      if (type === 'pdf') openPdf(kycId, side, card.dataset.label);
      else openLightbox(kycId, side, card.dataset.label);
    });
  });

  detailEl.querySelectorAll('.doc-approve-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      approveKycDoc(driverId, btn.dataset.kycId);
    });
  });

  detailEl.querySelectorAll('.doc-reject-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDocRejectModal(driverId, btn.dataset.kycId);
    });
  });
}

function buildDocGrid(driverId, kycDocs) {
  if (!kycDocs.length) return '<div class="no-docs">⚠️ No documents uploaded yet</div>';

  const cards = kycDocs.map((k) => {
    const status = k.status || 'pending';
    const reason = k.rejectionReason || '';
    const badge  = `<span class="doc-status-badge ${status}">${status.toUpperCase()}</span>`;
    const rejectionMsg = status === 'rejected' && reason
      ? `<div class="doc-rejection-msg">Rejected: ${escHtml(reason)}</div>`
      : '';

    const sides = [{ key: 'fileUrlFront', label: 'Front' }];
    if (k.fileUrlBack) sides.push({ key: 'fileUrlBack', label: 'Back' });

    return sides.map(({ key, label }) => {
      const val = k[key];
      const isPdf = val && val.includes('application/pdf');
      const isImg = val && (val.startsWith('data:image') || /^https?:\/\//.test(val));

      let preview;
      if (isPdf) {
        preview = `<div class="doc-preview"><div class="pdf-icon">📄</div><div class="doc-overlay">👁 Open PDF</div></div>`;
      } else if (isImg) {
        preview = `<div class="doc-preview"><img src="${val}" alt="${escHtml(k.type)}" loading="lazy"/><div class="doc-overlay">🔍 View Full</div></div>`;
      } else {
        preview = `<div class="doc-preview"><span style="color:var(--muted);font-size:13px">No preview</span></div>`;
      }

      const fullLabel = `${k.type} (${label})`;
      const actionButtons = label === 'Front' ? `
        <div class="doc-action-bar">
          <button class="btn btn-approve btn-sm doc-approve-btn" data-kyc-id="${k._id}">Approve</button>
          <button class="btn btn-reject btn-sm doc-reject-btn" data-kyc-id="${k._id}">Reject</button>
        </div>
      ` : '';

      return `
        <div class="doc-card" data-kyc-id="${escAttr(k._id)}" data-side="${key}" data-doc-type="${isPdf ? 'pdf' : 'img'}" data-label="${escAttr(fullLabel)}">
          ${badge}
          ${preview}
          <div class="doc-label">${escHtml(fullLabel)}</div>
          ${rejectionMsg}
          ${actionButtons}
        </div>
      `;
    }).join('');
  }).join('');

  return `<div class="doc-grid">${cards}</div>`;
}

// ── Lightbox ───────────────────────────────────────────────────────────────
function openLightbox(kycId, side, label) {
  const doc = docStore[kycId];
  if (!doc) return;
  const src = doc[side];
  if (!src) return;
  lightboxImg.src           = src;
  lightboxLabel.textContent = label;
  lightbox.classList.add('open');
}

function closeLightbox() {
  lightbox.classList.remove('open');
  lightboxImg.src = '';
}

function openPdf(kycId, side, label) {
  const doc = docStore[kycId];
  if (!doc) return;
  const src = doc[side];
  if (!src) return;
  const win = window.open('', '_blank');
  win.document.write(`<title>${label}</title><iframe src="${src}" style="width:100%;height:100vh;border:none;"></iframe>`);
}

lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

// ── Approve / Reject driver ─────────────────────────────────────────────────
async function approveDriver(driverId) {
  try {
    await apiFetch(`/api/v1/admin/drivers/${driverId}/approve`, {
      method: 'PUT',
      body: JSON.stringify({ kycStatus: 'approved' }),
    });
    showToast('✅ Driver approved successfully!', 'success');
    delete driverDetailCache[driverId];
    loadStats(); loadDrivers();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

function openRejectModal(driverId) {
  rejectTargetId = driverId;
  document.getElementById('reject-reason').value = '';
  rejectModal.classList.add('open');
}

function closeRejectModal() {
  rejectModal.classList.remove('open');
  rejectTargetId = null;
}

cancelReject.addEventListener('click', closeRejectModal);
rejectModal.addEventListener('click', (e) => { if (e.target === rejectModal) closeRejectModal(); });

confirmReject.addEventListener('click', async () => {
  const reason = document.getElementById('reject-reason').value.trim();
  if (!reason) { alert('Please provide a rejection reason.'); return; }
  try {
    await apiFetch(`/api/v1/admin/drivers/${rejectTargetId}/approve`, {
      method: 'PUT',
      body: JSON.stringify({ kycStatus: 'rejected', rejectionReason: reason }),
    });
    delete driverDetailCache[rejectTargetId];
    closeRejectModal();
    showToast('Driver rejected. Reason sent to driver.', 'error');
    loadStats(); loadDrivers();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
});

// ── Document level actions ──────────────────────────────────────────────────
async function approveKycDoc(driverId, kycId) {
  try {
    await apiFetch(`/api/v1/admin/drivers/${driverId}/kyc/${kycId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'approved' }),
    });
    showToast('✅ Document approved successfully!', 'success');
    delete driverDetailCache[driverId];
    await toggleCollapseThenReopen(driverId);
    loadStats(); loadDrivers();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

function openDocRejectModal(driverId, kycId) {
  docRejectDriverId = driverId;
  docRejectKycId = kycId;
  document.getElementById('doc-reject-reason').value = '';
  docRejectModal.classList.add('open');
}

function closeDocRejectModal() {
  docRejectModal.classList.remove('open');
  docRejectDriverId = null;
  docRejectKycId = null;
}

cancelDocReject.addEventListener('click', closeDocRejectModal);
docRejectModal.addEventListener('click', (e) => { if (e.target === docRejectModal) closeDocRejectModal(); });

confirmDocReject.addEventListener('click', async () => {
  const reason = document.getElementById('doc-reject-reason').value.trim();
  if (!reason) { alert('Please provide a rejection reason.'); return; }
  try {
    await apiFetch(`/api/v1/admin/drivers/${docRejectDriverId}/kyc/${docRejectKycId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'rejected', rejectionReason: reason }),
    });
    const driverId = docRejectDriverId;
    delete driverDetailCache[driverId];
    closeDocRejectModal();
    showToast('Document rejected. Rejection reason saved.', 'error');
    await toggleCollapseThenReopen(driverId);
    loadStats(); loadDrivers();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
});

// Re-fetch & re-render an expanded card's detail in place, without collapsing the list
async function toggleCollapseThenReopen(driverId) {
  const card = document.getElementById(`vc-${driverId}`);
  if (!card || !card.classList.contains('expanded')) return;
  try {
    const res = await apiFetch(`/api/v1/admin/drivers/${driverId}`);
    driverDetailCache[driverId] = res.data;
    (res.data.kycDocs || []).forEach(k => { docStore[k._id] = k; });
    renderDriverDetail(driverId);
  } catch (_) { /* silent — next full refresh will fix it */ }
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className   = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Init: mark pending tab active on load ─────────────────────────────────
document.querySelector('#drivers-section .filter-tab[data-filter="pending"]').dataset.active = 'pending';
document.getElementById('stat-pending').classList.add('ring');
