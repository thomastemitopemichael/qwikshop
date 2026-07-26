// ═══════════════════════════════════════════════════════════════
// QuickShop Admin — admin.js
// ═══════════════════════════════════════════════════════════════
// The admin panel is typically opened as a normal web page by shop
// staff (not embedded in the customer-facing WebView app), so unlike
// the customer app, it's fine to let an admin set/persist their backend
// URL locally once. window.QUICKSHOP_API_BASE (if injected) still wins.
const API_BASE = window.QUICKSHOP_API_BASE || localStorage.getItem('qs_admin_api_base') || 'http://localhost:4000/api';
let ADMIN_KEY = sessionStorage.getItem('qs_admin_key') || '';
let categories = [], products = [], customers = [];
let currentOrderTab = 'new';

async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3500);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function money(n) { return '₦' + Number(n || 0).toLocaleString(); }
function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

// ── CONFIRM DIALOG ──────────────────────────────────────────────
let _confirmResolve = null;
function askConfirm(title, msg) {
  document.getElementById('cTitle').textContent = title;
  document.getElementById('cMsg').textContent = msg;
  document.getElementById('confirmDlg').classList.add('open');
  return new Promise(resolve => { _confirmResolve = resolve; });
}
function resolveConfirm(val) {
  document.getElementById('confirmDlg').classList.remove('open');
  if (_confirmResolve) { _confirmResolve(val); _confirmResolve = null; }
}

// ── AUTH ─────────────────────────────────────────────────────────
async function doLogin() {
  const key = document.getElementById('adminKeyInput').value.trim();
  if (!key) { showLoginWarn('Enter your admin key.'); return; }
  ADMIN_KEY = key;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Verifying...';
  try {
    await api('/admin/overview'); // validates key
    sessionStorage.setItem('qs_admin_key', key);
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').classList.add('visible');
    boot();
  } catch (e) {
    showLoginWarn('Invalid admin key. Please try again.');
    btn.disabled = false; btn.innerHTML = 'Sign In';
  }
}
function showLoginWarn(msg) { const el = document.getElementById('loginWarn'); el.textContent = msg; el.style.display = 'block'; }
function doLogout() { sessionStorage.removeItem('qs_admin_key'); location.reload(); }

async function boot() {
  await Promise.all([loadCategories(), loadProducts()]);
  showPage('overview');
}

function toggleMobNav() { document.querySelector('.sidebar').classList.toggle('open'); }

function showPage(pg) {
  document.querySelectorAll('.nav-item, .mob-nav-item').forEach(el => el.classList.toggle('act', el.dataset.pg === pg));
  const renderers = { overview: renderOverviewPage, orders: renderOrdersPage, products: renderProductsPage, categories: renderCategoriesPage, customers: renderCustomersPage, analytics: renderAnalyticsPage, notifications: renderNotificationsPage, settings: renderSettingsPage };
  document.getElementById('mainArea').innerHTML = renderers[pg] ? renderers[pg]() : '';
  const loaders = { overview: loadOverview, orders: () => loadOrders(currentOrderTab), products: loadProducts, categories: loadCategories, customers: loadCustomers, analytics: loadAnalytics, settings: loadSettings };
  if (loaders[pg]) loaders[pg]();
}

// Auto-login if key already in session
window.addEventListener('DOMContentLoaded', () => {
  if (ADMIN_KEY) {
    api('/admin/overview').then(() => {
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('appScreen').classList.add('visible');
      boot();
    }).catch(() => { sessionStorage.removeItem('qs_admin_key'); });
  }
});

// ═══════════════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════════════
function renderOverviewPage() {
  return `
    <div class="section-head"><h2>Overview</h2><button class="btn bg bs" onclick="loadOverview()">↻ Refresh</button></div>
    <div class="stat-grid">
      <div class="stat-card sc-blue"><div class="stat-lbl">Total Orders</div><div class="stat-val" id="ov-orders">—</div></div>
      <div class="stat-card sc-amber"><div class="stat-lbl">Pending Pre-Orders</div><div class="stat-val" id="ov-preorders">—</div></div>
      <div class="stat-card sc-green"><div class="stat-lbl">Active Products</div><div class="stat-val" id="ov-products">—</div></div>
      <div class="stat-card sc-red"><div class="stat-lbl">Low Stock</div><div class="stat-val" id="ov-lowstock">—</div></div>
      <div class="stat-card sc-purple"><div class="stat-lbl">Customers</div><div class="stat-val" id="ov-customers">—</div></div>
    </div>
    <div class="card">
      <div style="font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:4px">Total Revenue</div>
      <div style="font-family:'Syne',sans-serif;font-size:34px;font-weight:800;color:var(--green)" id="ov-revenue">₦0</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>⚠️ Low Stock Products</h3></div>
      <div id="ov-lowstock-list"><p class="fhint">Loading...</p></div>
    </div>
  `;
}
async function loadOverview() {
  try {
    const o = await api('/admin/overview');
    setEl('ov-orders', o.total_orders);
    setEl('ov-preorders', o.pending_preorders);
    setEl('ov-products', o.total_products);
    setEl('ov-lowstock', o.low_stock_count);
    setEl('ov-customers', o.total_customers);
    setEl('ov-revenue', money(o.total_revenue));
    const badge = document.getElementById('ordersBadge');
    if (badge) { badge.textContent = o.pending_preorders; badge.style.display = o.pending_preorders > 0 ? 'inline-block' : 'none'; }
    const list = document.getElementById('ov-lowstock-list');
    if (list) {
      if (!o.low_stock_products.length) list.innerHTML = '<p class="fhint">All stock levels look healthy.</p>';
      else list.innerHTML = o.low_stock_products.map(p => `<div class="srow"><div><h4>${esc(p.name)}</h4></div><span class="badge b-lowstock">${p.stock_count} left</span></div>`).join('');
    }
  } catch (e) { toast('Overview error: ' + e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// ORDERS QUEUE
// ═══════════════════════════════════════════════════════════════
function renderOrdersPage() {
  return `
    <div class="section-head"><h2>Orders</h2><button class="btn bg bs" onclick="loadOrders(currentOrderTab)">↻ Refresh</button></div>
    <div class="seg">
      <button class="seg-tab active" data-tab="new" onclick="switchOrderTab('new')">New</button>
      <button class="seg-tab" data-tab="scheduled" onclick="switchOrderTab('scheduled')">Scheduled</button>
      <button class="seg-tab" data-tab="pending_preorders" onclick="switchOrderTab('pending_preorders')">Pending Pre-Orders</button>
      <button class="seg-tab" data-tab="history" onclick="switchOrderTab('history')">History</button>
    </div>
    <div id="ordersList"><p class="fhint">Loading...</p></div>
  `;
}
function switchOrderTab(tab) {
  currentOrderTab = tab;
  document.querySelectorAll('.seg-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  loadOrders(tab);
}
async function loadOrders(tab) {
  try {
    const orders = await api(`/admin/orders?tab=${tab}`);
    const list = document.getElementById('ordersList');
    if (!list) return;
    if (!orders.length) { list.innerHTML = '<div class="card"><p class="empty-table">No orders here.</p></div>'; return; }
    list.innerHTML = orders.map(o => renderOrderRow(o, tab)).join('');
  } catch (e) { toast('Orders error: ' + e.message, 'error'); }
}
function orderStatusBadge(status) {
  const map = { pending: 'b-pending', confirmed: 'b-confirmed', fulfilled: 'b-fulfilled', rejected: 'b-rejected', cancelled: 'b-cancelled' };
  return `<span class="badge ${map[status] || 'b-pending'}">${status}</span>`;
}
function renderOrderRow(o, tab) {
  const cust = o.customers || {};
  const itemsHtml = (o.order_items || []).map(i => `
    <div class="srow">
      <div>
        <h4>${esc(i.description)} <span style="color:var(--txt3);font-weight:400">×${i.quantity}</span></h4>
        ${i.customer_suggested_price != null ? `<p>Customer offered: ${money(i.customer_suggested_price)}</p>` : ''}
        ${i.line_status && i.line_status !== 'accepted' && o.type !== 'catalog' ? `<p>Status: ${i.line_status}</p>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${i.admin_price != null ? `<strong>${money(i.admin_price)}</strong>` : ''}
        ${o.type !== 'catalog' && i.line_status === 'pending' ? `
          <button class="btn bgreen bs" onclick="decideOrderItem('${i.id}','accepted')">Accept</button>
          <button class="btn bd bs" onclick="decideOrderItem('${i.id}','rejected')">Reject</button>
        ` : ''}
      </div>
    </div>`).join('');

  return `
  <div class="card">
    <div class="card-head">
      <div>
        <h3>#${o.id.slice(0,8)} ${o.type !== 'catalog' ? `<span class="badge b-custom">${o.type === 'restock_preorder' ? 'Restock' : 'Custom'}</span>` : ''}</h3>
        <p class="fhint">${esc(cust.name || 'Guest')} · ${esc(cust.email || cust.phone || '')}</p>
      </div>
      <div style="text-align:right">
        ${orderStatusBadge(o.status)}
        <div class="fhint">${new Date(o.created_at).toLocaleString()}</div>
        ${o.scheduled_for ? `<div class="fhint" style="color:var(--amber)">📅 ${new Date(o.scheduled_for).toLocaleString()}</div>` : ''}
      </div>
    </div>
    ${itemsHtml}
    <div class="srow" style="border-bottom:none;padding-top:12px">
      <strong>Total: ${money(o.total_amount)}</strong>
      <div style="display:flex;gap:8px">
        ${o.status === 'confirmed' ? `<button class="btn bp bs" onclick="fulfillOrder('${o.id}')">Mark Fulfilled</button>` : ''}
        ${(o.status === 'confirmed' || o.status === 'pending') ? `<button class="btn bd bs" onclick="cancelOrder('${o.id}')">Cancel</button>` : ''}
      </div>
    </div>
  </div>`;
}
async function decideOrderItem(itemId, decision) {
  let admin_price = null;
  if (decision === 'accepted') {
    admin_price = prompt('Confirm final price for this item (₦):');
    if (admin_price === null) return;
    if (!admin_price || isNaN(parseInt(admin_price))) { toast('Enter a valid price', 'error'); return; }
  } else {
    const ok = await askConfirm('Reject this item?', 'The customer will be notified this item could not be fulfilled.');
    if (!ok) return;
  }
  try {
    await api(`/admin/order-items/${itemId}/decide`, 'PUT', { decision, admin_price });
    toast(decision === 'accepted' ? 'Item priced and accepted' : 'Item rejected', 'success');
    loadOrders(currentOrderTab);
    loadOverview();
  } catch (e) { toast(e.message, 'error'); }
}
async function fulfillOrder(id) {
  try { await api(`/admin/orders/${id}/fulfill`, 'PUT'); toast('Order marked fulfilled', 'success'); loadOrders(currentOrderTab); }
  catch (e) { toast(e.message, 'error'); }
}
async function cancelOrder(id) {
  const ok = await askConfirm('Cancel this order?', 'Stock will be released back and the customer notified.');
  if (!ok) return;
  const reason = prompt('Reason for cancellation (optional):') || null;
  try { await api(`/admin/orders/${id}/cancel`, 'PUT', { reason }); toast('Order cancelled', 'success'); loadOrders(currentOrderTab); loadOverview(); }
  catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════
function renderProductsPage() {
  return `
    <div class="section-head">
      <h2>Products</h2>
      <div style="display:flex;gap:8px">
        <button class="btn bg bs" onclick="openCsvImportModal()">📄 Import CSV</button>
        <button class="btn bp bs" onclick="openProductModal()">+ Add Product</button>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><div class="tbl-wrap">
      <table class="tbl"><thead><tr><th>Product</th><th>Category</th><th>Stock</th><th>Price</th><th>Status</th><th>Manage</th></tr></thead>
      <tbody id="productsBody"><tr><td colspan="6" class="empty-table"><div class="spin"></div> Loading...</td></tr></tbody></table>
    </div></div>
  `;
}
async function loadProducts() {
  try {
    products = await api('/admin/products');
    const tbody = document.getElementById('productsBody');
    if (!tbody) return;
    if (!products.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-table">No products yet. Add your first one!</td></tr>'; return; }
    tbody.innerHTML = products.map(p => {
      const cheapest = p.product_price_tiers && p.product_price_tiers.length ? [...p.product_price_tiers].sort((a,b)=>(a.price/a.min_qty)-(b.price/b.min_qty))[0] : null;
      const stockBadge = p.stock_count <= 0 ? '<span class="badge b-outstock">Out</span>' : p.stock_count <= p.low_stock_threshold ? '<span class="badge b-lowstock">Low</span>' : '<span class="badge b-instock">OK</span>';
      return `<tr>
        <td><strong>${esc(p.name)}</strong>${p.description ? `<div class="fhint">${esc(p.description)}</div>` : ''}</td>
        <td>${p.categories ? esc(p.categories.icon) + ' ' + esc(p.categories.name) : '<span class="fhint">Uncategorized</span>'}</td>
        <td>
          <div class="stock-adjust">
            <button class="stock-btn" onclick="adjustStock('${p.id}',-1)">−</button>
            <span>${p.stock_count}</span>
            <button class="stock-btn" onclick="adjustStock('${p.id}',1)">+</button>
          </div>
          ${stockBadge}
        </td>
        <td>${cheapest ? money(cheapest.price/cheapest.min_qty) : '<span class="fhint">Not set</span>'}</td>
        <td>${p.is_active ? '<span class="badge b-active">Active</span>' : '<span class="badge b-inactive">Inactive</span>'}</td>
        <td>
          <button class="btn bg bs" onclick="openProductModal('${p.id}')">Edit</button>
          <button class="btn bg bs" onclick="duplicateProduct('${p.id}')">Duplicate</button>
          <button class="btn bd bs" onclick="deleteProduct('${p.id}')">Delete</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) { toast('Products error: ' + e.message, 'error'); }
}
async function adjustStock(id, delta) {
  try { await api(`/admin/products/${id}/adjust-stock`, 'POST', { delta }); loadProducts(); }
  catch (e) { toast(e.message, 'error'); }
}
async function duplicateProduct(id) {
  try { await api(`/admin/products/${id}/duplicate`, 'POST'); toast('Product duplicated', 'success'); loadProducts(); }
  catch (e) { toast(e.message, 'error'); }
}
async function deleteProduct(id) {
  const ok = await askConfirm('Delete this product?', 'This cannot be undone. Consider marking it inactive instead if you may need it again.');
  if (!ok) return;
  try { await api(`/admin/products/${id}`, 'DELETE'); toast('Product deleted', 'success'); loadProducts(); }
  catch (e) { toast(e.message, 'error'); }
}

// ── PRODUCT MODAL (add/edit with tier repeater) ────────────────
function openProductModal(id) {
  const p = id ? products.find(x => x.id === id) : null;
  const tiers = p ? (p.product_price_tiers || []) : [{ min_qty: 1, price: '' }];
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="productOverlay" onclick="if(event.target===this)closeModal('productOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">${p ? 'Edit' : 'Add'} Product</span><button class="mclose" onclick="closeModal('productOverlay')">&times;</button></div>
        <div class="fg"><label class="fl">Name</label><input class="fi" id="pName" value="${p ? esc(p.name) : ''}"></div>
        <div class="fg"><label class="fl">Description</label><textarea class="fi" id="pDesc" rows="2">${p ? esc(p.description || '') : ''}</textarea></div>
        <div class="fr">
          <div class="fg"><label class="fl">Category</label><select class="fi" id="pCategory"><option value="">Uncategorized</option>${categories.map(c => `<option value="${c.id}" ${p && p.category_id === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></div>
          <div class="fg"><label class="fl">Unit label</label><input class="fi" id="pUnitLabel" placeholder="sachet, pack, bottle..." value="${p ? esc(p.unit_label || 'unit') : 'unit'}"></div>
        </div>
        <div class="fr">
          <div class="fg"><label class="fl">Stock count</label><input class="fi" id="pStock" type="number" min="0" value="${p ? p.stock_count : 0}"></div>
          <div class="fg"><label class="fl">Low stock threshold</label><input class="fi" id="pThreshold" type="number" min="0" value="${p ? p.low_stock_threshold : 5}"></div>
        </div>
        ${p ? `<div class="fg"><label class="fl">Status</label><div class="tog"><input type="checkbox" id="pActive" ${p.is_active ? 'checked' : ''}><span class="tog-t"></span></div> <span class="fhint">Inactive products are hidden from customers but keep their order history.</span></div>` : ''}

        <div class="fg">
          <label class="fl">Bulk Price Tiers</label>
          <div class="fhint" style="margin-bottom:8px">E.g. 1 for ₦220, 5 for ₦1000, 10 for ₦1800. The best matching tier (highest qty ≤ ordered) is used at checkout.</div>
          <div id="tierRows">${tiers.map((t, i) => tierRowHtml(t, i)).join('')}</div>
          <button class="btn bg bs" onclick="addTierRow()">+ Add Tier</button>
        </div>

        <button class="btn bp full" style="margin-top:12px" onclick="saveProduct(${p ? `'${p.id}'` : 'null'})">Save Product</button>
      </div>
    </div>`;
}
function tierRowHtml(t, i) {
  return `<div class="tier-row" data-idx="${i}">
    <input class="fi" type="number" min="1" placeholder="Min qty" value="${t.min_qty ?? ''}">
    <input class="fi" type="number" min="0" placeholder="Price (₦)" value="${t.price ?? ''}">
    <button class="tier-remove" onclick="this.closest('.tier-row').remove()">✕</button>
  </div>`;
}
function addTierRow() {
  const container = document.getElementById('tierRows');
  const div = document.createElement('div');
  div.className = 'tier-row';
  div.innerHTML = `<input class="fi" type="number" min="1" placeholder="Min qty"><input class="fi" type="number" min="0" placeholder="Price (₦)"><button class="tier-remove" onclick="this.closest('.tier-row').remove()">✕</button>`;
  container.appendChild(div);
}
function collectTiers() {
  return [...document.querySelectorAll('#tierRows .tier-row')].map(row => {
    const inputs = row.querySelectorAll('input');
    return { min_qty: parseInt(inputs[0].value), price: parseInt(inputs[1].value) };
  }).filter(t => t.min_qty > 0 && t.price >= 0 && !isNaN(t.min_qty) && !isNaN(t.price));
}
async function saveProduct(id) {
  const payload = {
    name: document.getElementById('pName').value.trim(),
    description: document.getElementById('pDesc').value.trim(),
    category_id: document.getElementById('pCategory').value || null,
    unit_label: document.getElementById('pUnitLabel').value.trim() || 'unit',
    stock_count: parseInt(document.getElementById('pStock').value) || 0,
    low_stock_threshold: parseInt(document.getElementById('pThreshold').value) || 5,
    tiers: collectTiers()
  };
  if (!payload.name) { toast('Name is required', 'error'); return; }
  if (id) {
    const activeEl = document.getElementById('pActive');
    if (activeEl) payload.is_active = activeEl.checked;
  }
  try {
    if (id) await api(`/admin/products/${id}`, 'PUT', payload);
    else await api('/admin/products', 'POST', payload);
    toast('Product saved', 'success');
    closeModal('productOverlay');
    loadProducts();
  } catch (e) { toast(e.message, 'error'); }
}

// ── CSV IMPORT ───────────────────────────────────────────────────
function openCsvImportModal() {
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="csvOverlay" onclick="if(event.target===this)closeModal('csvOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">Import Products (CSV)</span><button class="mclose" onclick="closeModal('csvOverlay')">&times;</button></div>
        <div class="fhint" style="margin-bottom:10px">Header row required: name,description,category_name,stock_count,low_stock_threshold,unit_label,tier1_qty,tier1_price,tier2_qty,tier2_price,...</div>
        <textarea class="fi" id="csvInput" rows="8" placeholder="name,description,category_name,stock_count,low_stock_threshold,unit_label,tier1_qty,tier1_price&#10;Bottled Water,500ml,Beverages,50,10,bottle,1,150,6,800"></textarea>
        <button class="btn bp full" style="margin-top:12px" onclick="submitCsvImport()">Import</button>
      </div>
    </div>`;
}
async function submitCsvImport() {
  const csv = document.getElementById('csvInput').value.trim();
  if (!csv) { toast('Paste CSV content first', 'error'); return; }
  try {
    const result = await api('/admin/products/import-csv', 'POST', { csv });
    toast(`Imported ${result.imported} product(s)${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`, result.errors.length ? 'warn' : 'success');
    closeModal('csvOverlay');
    loadProducts();
  } catch (e) { toast(e.message, 'error'); }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('open'); setTimeout(() => { document.getElementById('modalRoot').innerHTML = ''; }, 200); }
}

// ═══════════════════════════════════════════════════════════════
// CATEGORIES
// ═══════════════════════════════════════════════════════════════
function renderCategoriesPage() {
  return `
    <div class="section-head"><h2>Categories</h2><button class="btn bp bs" onclick="openCategoryModal()">+ Add Category</button></div>
    <div class="card" style="padding:0;overflow:hidden"><div class="tbl-wrap">
      <table class="tbl"><thead><tr><th>Icon</th><th>Name</th><th>Sort Order</th><th>Status</th><th>Manage</th></tr></thead>
      <tbody id="categoriesBody"><tr><td colspan="5" class="empty-table"><div class="spin"></div> Loading...</td></tr></tbody></table>
    </div></div>
  `;
}
async function loadCategories() {
  try {
    categories = await api('/admin/categories');
    const tbody = document.getElementById('categoriesBody');
    if (!tbody) return;
    if (!categories.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-table">No categories yet.</td></tr>'; return; }
    tbody.innerHTML = categories.map(c => `<tr>
      <td style="font-size:20px">${esc(c.icon)}</td>
      <td><strong style="color:${esc(c.color)}">${esc(c.name)}</strong></td>
      <td>${c.sort_order}</td>
      <td>${c.is_active ? '<span class="badge b-active">Active</span>' : '<span class="badge b-inactive">Inactive</span>'}</td>
      <td><button class="btn bg bs" onclick="openCategoryModal('${c.id}')">Edit</button> <button class="btn bd bs" onclick="deleteCategory('${c.id}')">Delete</button></td>
    </tr>`).join('');
  } catch (e) { toast('Categories error: ' + e.message, 'error'); }
}
function openCategoryModal(id) {
  const c = id ? categories.find(x => x.id === id) : null;
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="categoryOverlay" onclick="if(event.target===this)closeModal('categoryOverlay')">
      <div class="modal" style="max-width:420px">
        <div class="mhead"><span class="mtitle">${c ? 'Edit' : 'Add'} Category</span><button class="mclose" onclick="closeModal('categoryOverlay')">&times;</button></div>
        <div class="fg"><label class="fl">Name</label><input class="fi" id="catName" value="${c ? esc(c.name) : ''}"></div>
        <div class="fr">
          <div class="fg"><label class="fl">Icon (emoji)</label><input class="fi" id="catIcon" value="${c ? esc(c.icon) : '📦'}"></div>
          <div class="fg"><label class="fl">Color</label><input class="fi" id="catColor" type="color" value="${c ? c.color : '#3B82F6'}" style="height:38px;padding:4px"></div>
        </div>
        <div class="fg"><label class="fl">Sort Order</label><input class="fi" id="catSort" type="number" value="${c ? c.sort_order : 0}"></div>
        ${c ? `<div class="fg"><label class="fl">Status</label><div class="tog"><input type="checkbox" id="catActive" ${c.is_active ? 'checked' : ''}><span class="tog-t"></span></div></div>` : ''}
        <button class="btn bp full" onclick="saveCategory(${c ? `'${c.id}'` : 'null'})">Save Category</button>
      </div>
    </div>`;
}
async function saveCategory(id) {
  const payload = { name: document.getElementById('catName').value.trim(), icon: document.getElementById('catIcon').value.trim() || '📦', color: document.getElementById('catColor').value, sort_order: parseInt(document.getElementById('catSort').value) || 0 };
  if (!payload.name) { toast('Name is required', 'error'); return; }
  if (id) { const el = document.getElementById('catActive'); if (el) payload.is_active = el.checked; }
  try {
    if (id) await api(`/admin/categories/${id}`, 'PUT', payload);
    else await api('/admin/categories', 'POST', payload);
    toast('Category saved', 'success');
    closeModal('categoryOverlay');
    loadCategories();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteCategory(id) {
  const ok = await askConfirm('Delete this category?', 'Products in this category will become uncategorized.');
  if (!ok) return;
  try { await api(`/admin/categories/${id}`, 'DELETE'); toast('Category deleted', 'success'); loadCategories(); }
  catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════
function renderCustomersPage() {
  return `
    <div class="section-head"><h2>Customers</h2><button class="btn bg bs" onclick="loadCustomers()">↻ Refresh</button></div>
    <div class="card" style="padding:0;overflow:hidden"><div class="tbl-wrap">
      <table class="tbl"><thead><tr><th>Name</th><th>Contact</th><th>Notify via</th><th>Joined</th><th>Status</th><th>Manage</th></tr></thead>
      <tbody id="customersBody"><tr><td colspan="6" class="empty-table"><div class="spin"></div> Loading...</td></tr></tbody></table>
    </div></div>
  `;
}
async function loadCustomers() {
  try {
    customers = await api('/admin/customers');
    const tbody = document.getElementById('customersBody');
    if (!tbody) return;
    if (!customers.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-table">No customers yet.</td></tr>'; return; }
    tbody.innerHTML = customers.map(c => `<tr>
      <td>${esc(c.name || 'Guest')}</td>
      <td>${esc(c.email || '')} ${c.phone ? '<br>' + esc(c.phone) : ''}</td>
      <td><span class="fhint">${esc(c.notify_preference || 'email')}</span></td>
      <td>${new Date(c.created_at).toLocaleDateString()}</td>
      <td>${c.is_blocked ? '<span class="badge b-outstock">Blocked</span>' : '<span class="badge b-instock">Active</span>'}</td>
      <td><button class="btn ${c.is_blocked ? 'bgreen' : 'bd'} bs" onclick="toggleBlockCustomer('${c.id}',${!c.is_blocked})">${c.is_blocked ? 'Unblock' : 'Block'}</button></td>
    </tr>`).join('');
  } catch (e) { toast('Customers error: ' + e.message, 'error'); }
}
async function toggleBlockCustomer(id, blocked) {
  try { await api(`/admin/customers/${id}/block`, 'PUT', { blocked }); toast(blocked ? 'Customer blocked' : 'Customer unblocked', 'success'); loadCustomers(); }
  catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════
function renderAnalyticsPage() {
  return `
    <div class="section-head"><h2>Analytics</h2><button class="btn bg bs" onclick="loadAnalytics()">↻ Refresh</button></div>
    <div class="card"><div class="card-head"><h3>🏆 Best Sellers</h3></div><div id="bestSellersList"><p class="fhint">Loading...</p></div></div>
    <div class="card"><div class="card-head"><h3>💰 Revenue by Category</h3></div><div id="revenueCategoryList"><p class="fhint">Loading...</p></div></div>
  `;
}
async function loadAnalytics() {
  try {
    const [best, revenue] = await Promise.all([api('/admin/analytics/best-sellers'), api('/admin/analytics/revenue-by-category')]);
    const bs = document.getElementById('bestSellersList');
    bs.innerHTML = best.length ? best.map((b, i) => `<div class="srow"><div><h4>#${i+1} ${esc(b.name)}</h4></div><strong>${b.total_qty} sold</strong></div>`).join('') : '<p class="fhint">No sales data yet.</p>';
    const rc = document.getElementById('revenueCategoryList');
    rc.innerHTML = revenue.length ? revenue.map(r => `<div class="srow"><div><h4>${esc(r.category)}</h4></div><strong>${money(r.revenue)}</strong></div>`).join('') : '<p class="fhint">No revenue data yet.</p>';
  } catch (e) { toast('Analytics error: ' + e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
// BROADCAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
function renderNotificationsPage() {
  return `
    <div class="section-head"><h2>Broadcast Notification</h2></div>
    <div class="card">
      <div class="fg"><label class="fl">Send to</label>
        <div style="display:flex;align-items:center;gap:8px"><div class="tog"><input type="checkbox" id="notifSendAll" checked onchange="document.getElementById('notifCustomerRow').style.display=this.checked?'none':'block'"><span class="tog-t"></span></div> <span class="fhint">All customers</span></div>
      </div>
      <div class="fg" id="notifCustomerRow" style="display:none"><label class="fl">Customer ID</label><input class="fi" id="notifCustomerId" placeholder="Paste customer ID from the Customers page"></div>
      <div class="fg"><label class="fl">Title</label><input class="fi" id="notifTitle" placeholder="e.g. New arrivals this week!"></div>
      <div class="fg"><label class="fl">Message</label><textarea class="fi" id="notifMessage" rows="3" placeholder="Your message..."></textarea></div>
      <button class="btn bp full" id="sendNotifBtn" onclick="sendBroadcast()">📣 Send Notification</button>
      <p id="notifResult" style="margin-top:10px;font-size:12px"></p>
    </div>
  `;
}
async function sendBroadcast() {
  const sendAll = document.getElementById('notifSendAll').checked;
  const customer_id = document.getElementById('notifCustomerId').value.trim();
  const title = document.getElementById('notifTitle').value.trim();
  const message = document.getElementById('notifMessage').value.trim();
  if (!title || !message) { toast('Title and message are required', 'error'); return; }
  if (!sendAll && !customer_id) { toast('Enter a customer ID or enable Send to All', 'error'); return; }
  const btn = document.getElementById('sendNotifBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Sending...';
  const res = document.getElementById('notifResult');
  try {
    const r = await api('/admin/broadcast/notification', 'POST', { send_all: sendAll, customer_id: customer_id || null, title, message });
    res.textContent = `✅ Sent to ${r.sent} customer${r.sent !== 1 ? 's' : ''}`;
    res.style.color = 'var(--green)';
    toast('Notification sent', 'success');
  } catch (e) { res.textContent = '❌ ' + e.message; res.style.color = 'var(--red)'; toast(e.message, 'error'); }
  btn.disabled = false; btn.innerHTML = '📣 Send Notification';
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════
function renderSettingsPage() {
  return `
    <div class="section-head"><h2>Settings</h2></div>
    <div class="card">
      <div class="card-head"><h3>Shop</h3></div>
      <div class="fr">
        <div class="fg"><label class="fl">Shop Name</label><input class="fi" id="s-shop_name"></div>
        <div class="fg"><label class="fl">Currency Symbol</label><input class="fi" id="s-currency_symbol"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Ordering Rules</h3></div>
      <div class="fr3">
        <div class="fg"><label class="fl">Min Lead Time (hrs)</label><input class="fi" id="s-min_lead_time_hours" type="number"></div>
        <div class="fg"><label class="fl">Min Order Value</label><input class="fi" id="s-min_order_value" type="number"></div>
        <div class="fg"><label class="fl">Delivery Fee</label><input class="fi" id="s-delivery_fee" type="number"></div>
      </div>
      <div class="fr3">
        <div class="fg"><label class="fl">Reservation Hold (min)</label><input class="fi" id="s-reservation_hold_minutes" type="number"></div>
        <div class="fg"><label class="fl">Pre-order Rate Limit</label><input class="fi" id="s-preorder_rate_limit" type="number"></div>
        <div class="fg"><label class="fl">Large Order Threshold</label><input class="fi" id="s-large_order_threshold" type="number"></div>
        <div class="fhint" style="grid-column:1/-1">Large order threshold is informational only (flags for review) — 0 disables it, per the autonomy-first order flow.</div>
      </div>
      <div class="fg"><label class="fl">Reminder Lead Time (hrs before scheduled order)</label><input class="fi" id="s-reminder_hours_before" type="number"></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Notification Channels</h3></div>
      <div class="fhint" style="margin-bottom:10px">Globally enable/disable each channel. Customers still choose their own preferred channels within what's enabled here.</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="s-allowed_email"> Email</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="s-allowed_sms"> SMS</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="s-allowed_push"> Push</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="s-allowed_telegram"> Telegram</label>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Payments</h3></div>
      <div class="srow"><div><h4>Enable Pay Online (Paystack)</h4></div><div class="tog"><input type="checkbox" id="s-paystack_enabled"><span class="tog-t"></span></div></div>
      <div class="fg"><label class="fl">Paystack Public Key</label><input class="fi" id="s-paystack_public_key"></div>
    </div>
    <button class="btn bp full" onclick="saveAllSettings()">Save All Settings</button>
  `;
}
async function loadSettings() {
  try {
    const s = await api('/admin/settings');
    Object.entries(s).forEach(([k, v]) => {
      if (k.startsWith('allowed_')) return;
      const el = document.getElementById('s-' + k);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = (v === 'true'); else el.value = v;
    });
    const allowed = (s.allowed_channels || 'email,sms,push,telegram').split(',').map(x => x.trim().toLowerCase());
    document.getElementById('s-allowed_email').checked = allowed.includes('email');
    document.getElementById('s-allowed_sms').checked = allowed.includes('sms');
    document.getElementById('s-allowed_push').checked = allowed.includes('push');
    document.getElementById('s-allowed_telegram').checked = allowed.includes('telegram');
  } catch (e) { toast('Settings load error: ' + e.message, 'error'); }
}
async function saveAllSettings() {
  const settings = {};
  document.querySelectorAll('[id^="s-"]').forEach(el => {
    const key = el.id.slice(2);
    if (key.startsWith('allowed_')) return;
    if (el.type === 'checkbox') settings[key] = el.checked ? 'true' : 'false';
    else if (el.value !== '') settings[key] = el.value;
  });
  const channels = [];
  if (document.getElementById('s-allowed_email').checked) channels.push('email');
  if (document.getElementById('s-allowed_sms').checked) channels.push('sms');
  if (document.getElementById('s-allowed_push').checked) channels.push('push');
  if (document.getElementById('s-allowed_telegram').checked) channels.push('telegram');
  if (!channels.length) { toast('At least one notification channel must stay enabled.', 'error'); return; }
  settings.allowed_channels = channels.join(',');
  try { await api('/admin/settings', 'PUT', settings); toast('Settings saved', 'success'); }
  catch (e) { toast('Save failed: ' + e.message, 'error'); }
}
