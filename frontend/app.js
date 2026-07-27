// ═══════════════════════════════════════════════════════════════
// Qwikshop — Customer App
// ═══════════════════════════════════════════════════════════════
// The native app shell injects window.QUICKSHOP_API_BASE before this
// script runs (WebView preload script / JS bridge global). There is no
// address bar in a WebView for a user to configure this, so we never
// read it from localStorage or prompt for it — only the injected value
// or a hardcoded fallback until the native bridge is wired up.
const API_BASE = window.QUICKSHOP_API_BASE || 'https://qwikshop.onrender.com/api';

// Supabase client — used only for holding/refreshing the session once
// signed in (via our own custom-code /api/auth/verify-code endpoint,
// not Supabase's native OTP UI). The anon key is safe to expose
// client-side by design; both values can be injected the same way as
// QUICKSHOP_API_BASE, with hardcoded fallbacks until that's wired up.
const SUPABASE_URL = window.QUICKSHOP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.QUICKSHOP_SUPABASE_ANON_KEY || '';
let supabaseClient = null;
if (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
}

// ── STATE ──────────────────────────────────────────────────────
let config = { shop_name: 'Qwikshop', currency_symbol: '₦', min_lead_time_hours: 2, min_order_value: 0, delivery_fee: 0 };
let categories = [];
let products = [];
let cart = JSON.parse(localStorage.getItem('qs_cart') || '[]'); // [{product_id, name, qty, tiers}]
let customerId = localStorage.getItem('qs_customer_id') || null;
let customerContact = JSON.parse(localStorage.getItem('qs_contact') || 'null'); // {name, email, phone}
let notifications = [];
let currentCategory = null;
let currentTab = 'shop'; // shop | orders | preorder | account
let orders = [];
let isOnline = navigator.onLine;
const NOTIF_CACHE_CAP = 100;

// ── AUTH SESSION STATE ─────────────────────────────────────────────
let authSession = null; // { access_token, refresh_token } once signed in
let authPendingEmail = null; // email awaiting code entry, mid sign-in flow

// ── API HELPERS (15s hard timeout via AbortController) ───────────
const REQUEST_TIMEOUT_MS = 15000;
async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (authSession?.access_token) opts.headers['Authorization'] = `Bearer ${authSession.access_token}`;
  if (body) opts.body = JSON.stringify(body);
  const controller = new AbortController();
  opts.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_BASE + path, opts);
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    setOnlineState(true);
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      setOnlineState(false);
      const timeoutErr = new Error('Request timed out — check your connection.');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    if (err instanceof TypeError) setOnlineState(false); // network-level failure
    throw err;
  }
}

// ── AUTH (custom 8+ char sign-in code, real Supabase session) ────
// Sign-in is required only at checkout; browsing, cart, and pre-orders
// stay fully guest-friendly. Session is persisted via Supabase's own
// client-side storage once established, refreshed automatically.
function restoreSession() {
  try {
    const raw = localStorage.getItem('qs_auth_session');
    if (!raw) return;
    authSession = JSON.parse(raw);
    if (supabaseClient && authSession?.access_token && authSession?.refresh_token) {
      supabaseClient.auth.setSession({ access_token: authSession.access_token, refresh_token: authSession.refresh_token });
    }
  } catch { authSession = null; }
}
function persistSession(session) {
  authSession = session;
  localStorage.setItem('qs_auth_session', JSON.stringify(session));
}
function isSignedIn() { return !!authSession?.access_token; }

async function requestSignInCode(email) {
  const result = await api('/auth/request-code', 'POST', { email });
  authPendingEmail = email;
  return result;
}
async function verifySignInCode(email, code) {
  const result = await api('/auth/verify-code', 'POST', { email, code });
  persistSession({ access_token: result.access_token, refresh_token: result.refresh_token });
  if (supabaseClient) supabaseClient.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
  customerId = result.customer_id;
  customerContact = { name: result.name, email: result.email, phone: result.phone };
  localStorage.setItem('qs_customer_id', customerId);
  localStorage.setItem('qs_contact', JSON.stringify(customerContact));
  authPendingEmail = null;
  refreshNotifications();
  return result;
}
function signOut() {
  authSession = null;
  authPendingEmail = null;
  localStorage.removeItem('qs_auth_session');
  if (supabaseClient) supabaseClient.auth.signOut();
  toast('Signed out', 'info');
  goTab('account');
}

// ── ONLINE / OFFLINE AWARENESS ────────────────────────────────────
// Browser online/offline events give instant detection; actual API
// call success/failure (above) is the secondary confirming signal,
// since a device can report "online" while the backend is unreachable.
function setOnlineState(online) {
  if (online === isOnline) return;
  isOnline = online;
  renderOfflineIndicator();
  if (online) {
    // Reconnected — refresh whatever's on screen right now.
    if (currentTab === 'shop' && !currentCategory) refreshCategoriesAndProducts();
    else if (currentTab === 'orders') loadOrders();
    if (customerId) refreshNotifications();
  }
}
function renderOfflineIndicator() {
  let el = document.getElementById('offlineBanner');
  if (!isOnline) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'offlineBanner';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--amber);color:#1a1400;font-size:11px;font-weight:700;text-align:center;padding:4px;z-index:600;letter-spacing:.3px';
      el.textContent = '⚠ Offline — showing saved data';
      document.body.prepend(el);
    }
  } else if (el) { el.remove(); }
}
window.addEventListener('online', () => setOnlineState(true));
window.addEventListener('offline', () => setOnlineState(false));

// ── PER-CUSTOMER LOCALSTORAGE CACHE ───────────────────────────────
// Only active once a customer_id exists (post first order/pre-order) —
// there's no stable identity to scope a cache key to before that, so
// pre-order browsing always hits the network live.
function cacheKey(resource) { return customerId ? `qs_cache_${customerId}_${resource}` : null; }
function cacheGet(resource) {
  const key = cacheKey(resource);
  if (!key) return null;
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function cacheSet(resource, data) {
  const key = cacheKey(resource);
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { console.warn('Cache write failed', e); }
}
function clearCustomerCache() {
  if (!customerId) return;
  const prefix = `qs_cache_${customerId}_`;
  Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k));
}

// ── TOAST ────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = { success: 'check-circle', error: 'x-circle', warn: 'alert-triangle', info: 'info' }[type];
  el.innerHTML = `<i data-lucide="${icon}" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${esc(msg)}</span>`;
  document.getElementById('toasts').appendChild(el);
  if (window.lucide) lucide.createIcons({ el });
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3500);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function money(n) { return `${config.currency_symbol}${Number(n || 0).toLocaleString()}`; }

// ── TIER HELPERS ───────────────────────────────────────────────
function matchTier(tiers, qty) {
  if (!tiers || !tiers.length) return null;
  const sorted = [...tiers].sort((a, b) => b.min_qty - a.min_qty);
  return sorted.find(t => qty >= t.min_qty) || sorted[sorted.length - 1];
}
function tierUnitPrice(tier) { return tier ? tier.price / tier.min_qty : 0; }
function priceForQty(tiers, qty) {
  const tier = matchTier(tiers, qty);
  if (!tier) return 0;
  return Math.round(tierUnitPrice(tier) * qty);
}
function cheapestTier(tiers) {
  if (!tiers || !tiers.length) return null;
  return [...tiers].sort((a, b) => tierUnitPrice(a) - tierUnitPrice(b))[0];
}

// ── CART PERSISTENCE ───────────────────────────────────────────
function saveCart() { localStorage.setItem('qs_cart', JSON.stringify(cart)); updateCartBadge(); }
function cartCount() { return cart.reduce((s, i) => s + i.qty, 0); }
function cartTotal() {
  return cart.reduce((sum, item) => {
    const product = products.find(p => p.id === item.product_id);
    if (!product) return sum;
    return sum + priceForQty(product.product_price_tiers, item.qty);
  }, 0) + (config.delivery_fee || 0);
}
function addToCart(product, qty) {
  const existing = cart.find(i => i.product_id === product.id);
  if (existing) existing.qty += qty;
  else cart.push({ product_id: product.id, name: product.name, qty });
  saveCart();
  toast(`Added ${qty} × ${product.name}`, 'success');
}
function updateCartQty(productId, qty) {
  const item = cart.find(i => i.product_id === productId);
  if (!item) return;
  if (qty <= 0) cart = cart.filter(i => i.product_id !== productId);
  else item.qty = qty;
  saveCart();
  renderCartModal();
}
function updateCartBadge() {
  const count = cartCount();
  ['cartCount', 'cartCountD'].forEach(id => {
    const badge = document.getElementById(id);
    if (badge) { badge.textContent = count; badge.style.display = count > 0 ? 'flex' : 'none'; }
  });
  // If the Cart tab is currently open, keep its contents live as the cart changes.
  if (currentTab === 'cart') {
    const html = renderCartPage();
    const mEl = document.getElementById('mContent'), dEl = document.getElementById('dContent');
    if (mEl) mEl.innerHTML = html;
    if (dEl) dEl.innerHTML = html;
    if (window.lucide) lucide.createIcons();
  }
}

// ── THEME TOGGLE ──────────────────────────────────────────────────
function applyAppTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('qs_theme', theme);
  document.querySelectorAll('#themeTabDark, #themeTabLight').forEach(el => el && el.classList.remove('active'));
  const activeTab = document.getElementById(theme === 'dark' ? 'themeTabDark' : 'themeTabLight');
  if (activeTab) activeTab.classList.add('active');
}
function setAppTheme(theme) { applyAppTheme(theme); }

// ── INIT (stale-while-revalidate) ─────────────────────────────────
// Render cached data instantly if present, then refresh in the
// background and silently update the UI. Data arrays are only ever
// reset to empty if the fetch fails AND there's no cache at all.
async function init() {
  applyAppTheme(localStorage.getItem('qs_theme') || 'dark');
  restoreSession();

  const cachedCategories = cacheGet('categories');
  const cachedProducts = cacheGet('products');
  if (cachedCategories) categories = cachedCategories;
  if (cachedProducts) products = cachedProducts;

  try { config = await api('/config'); } catch (e) { console.warn('Config load failed, using defaults', e); }

  document.getElementById('app').innerHTML = renderShell();
  document.getElementById('app').style.display = 'block';
  setTimeout(() => { document.getElementById('splash').classList.add('hide'); }, 900);

  updateCartBadge();
  goTab('shop');
  if (window.lucide) lucide.createIcons();
  renderOfflineIndicator();

  await refreshCategoriesAndProducts();
  if (customerId) refreshNotifications();
}

async function refreshCategoriesAndProducts() {
  if (!isOnline) return; // cached categories/products (if any) already rendered by init()
  try {
    const [freshCategories, freshProducts] = await Promise.all([api('/categories'), api('/products')]);
    categories = freshCategories;
    products = freshProducts;
    cacheSet('categories', categories);
    cacheSet('products', products);
    // Silently update whatever's currently on screen.
    if (currentTab === 'shop') {
      const html = currentCategory ? renderProductList() : renderCategoryGrid();
      const mEl = document.getElementById('mContent'), dEl = document.getElementById('dContent');
      if (mEl) mEl.innerHTML = html;
      if (dEl) dEl.innerHTML = html;
      if (window.lucide) lucide.createIcons();
    }
  } catch (e) {
    // Fetch failed — keep whatever's cached/already rendered on screen.
    // Only show the empty state if we truly have nothing at all.
    if (!categories.length && !products.length) {
      toast('Could not load shop data. Check your connection.', 'error');
    }
  }
}

// ── SHELL (mobile + desktop) ───────────────────────────────────
function renderShell() {
  return `
  <div class="m-shell m-only">
    <div class="m-top">
      <div class="m-logo"><i data-lucide="shopping-bag" style="width:20px;height:20px;color:var(--blue)"></i><span class="m-logo-txt">${esc(config.shop_name)}</span></div>
      <div class="m-top-r">
        <button class="notif-btn" onclick="openNotifModal()"><i data-lucide="bell" style="width:15px;height:15px"></i><span class="notif-dot" id="notifDotM"></span></button>
      </div>
    </div>
    <div class="m-content" id="mContent"></div>
    <div class="m-bot">
      <button class="m-nb act" data-tab="shop" onclick="goTab('shop')"><span class="m-ni"><i data-lucide="store" style="width:19px;height:19px"></i></span>Shop</button>
      <button class="m-nb" data-tab="cart" onclick="goTab('cart')"><span class="m-ni" style="position:relative"><i data-lucide="shopping-cart" style="width:19px;height:19px"></i><span class="cart-count" id="cartCount" style="display:none;position:absolute;top:-6px;right:-8px">0</span></span>Cart</button>
      <button class="m-nb" data-tab="preorder" onclick="goTab('preorder')"><span class="m-ni"><i data-lucide="clipboard-list" style="width:19px;height:19px"></i></span>Request</button>
      <button class="m-nb" data-tab="orders" onclick="goTab('orders')"><span class="m-ni"><i data-lucide="package" style="width:19px;height:19px"></i></span>Orders</button>
      <button class="m-nb" data-tab="account" onclick="goTab('account')"><span class="m-ni"><i data-lucide="user" style="width:19px;height:19px"></i></span>Account</button>
    </div>
  </div>

  <div class="d-shell d-only">
    <div class="d-side">
      <div class="d-logo"><i data-lucide="shopping-bag" style="width:22px;height:22px;color:var(--blue)"></i><span class="d-logo-txt">${esc(config.shop_name)}</span></div>
      <div class="d-nav">
        <div class="d-nitem act" data-tab="shop" onclick="goTab('shop')"><i data-lucide="store" style="width:16px;height:16px"></i>Shop</div>
        <div class="d-nitem" data-tab="cart" onclick="goTab('cart')"><i data-lucide="shopping-cart" style="width:16px;height:16px"></i>Cart<span class="cart-count" id="cartCountD" style="display:none;margin-left:auto;position:static">0</span></div>
        <div class="d-nitem" data-tab="preorder" onclick="goTab('preorder')"><i data-lucide="clipboard-list" style="width:16px;height:16px"></i>Request an Item</div>
        <div class="d-nitem" data-tab="orders" onclick="goTab('orders')"><i data-lucide="package" style="width:16px;height:16px"></i>My Orders</div>
        <div class="d-nitem" data-tab="account" onclick="goTab('account')"><i data-lucide="user" style="width:16px;height:16px"></i>Account</div>
      </div>
    </div>
    <div class="d-main">
      <div class="d-top">
        <span class="d-title" id="dTitle">Shop</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="notif-btn" onclick="openNotifModal()"><i data-lucide="bell" style="width:15px;height:15px"></i><span class="notif-dot" id="notifDotD"></span></button>
        </div>
      </div>
      <div class="d-content" id="dContent"></div>
    </div>
  </div>

  <!-- Modals mount point -->
  <div id="modalRoot"></div>
  `;
}

function goTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.m-nb, .d-nitem').forEach(el => el.classList.toggle('act', el.dataset.tab === tab));
  const titles = { shop: 'Shop', cart: 'Your Cart', preorder: 'Request an Item', orders: 'My Orders', account: 'Account' };
  const dTitle = document.getElementById('dTitle'); if (dTitle) dTitle.textContent = titles[tab];
  let html = '';
  if (tab === 'shop') html = currentCategory ? renderProductList() : renderCategoryGrid();
  else if (tab === 'cart') html = renderCartPage();
  else if (tab === 'preorder') html = renderPreorderForm();
  else if (tab === 'orders') html = renderOrdersPage();
  else if (tab === 'account') html = renderAccountPage();
  document.getElementById('mContent').innerHTML = html;
  document.getElementById('dContent').innerHTML = html;
  if (window.lucide) lucide.createIcons();
  if (tab === 'orders') loadOrders();
  if (tab === 'account') applyAppTheme(localStorage.getItem('qs_theme') || 'dark'); // refresh theme tab active state on freshly-rendered markup
}

// ── CATEGORY GRID ──────────────────────────────────────────────
let shopSearchQuery = '';
function renderCategoryGrid() {
  const searchBar = `
    <div class="fg" style="margin-bottom:14px">
      <div style="position:relative">
        <i data-lucide="search" style="width:15px;height:15px;position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--txt3)"></i>
        <input class="fi" style="padding-left:34px" id="shopSearchInput" placeholder="Search the catalogue..." value="${esc(shopSearchQuery)}" oninput="onShopSearchInput(this.value)">
        ${shopSearchQuery ? `<button onclick="clearShopSearch()" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--txt3);cursor:pointer;padding:4px"><i data-lucide="x" style="width:14px;height:14px"></i></button>` : ''}
      </div>
    </div>`;

  if (shopSearchQuery.trim()) return searchBar + renderSearchResults();

  if (!categories.length) return searchBar + `<div class="empty"><div class="empty-icon"><i data-lucide="store" style="width:34px;height:34px"></i></div><h3>No categories yet</h3><p>Check back soon.</p></div>`;
  return searchBar + `
    <div class="section-title">Browse Categories</div>
    <div class="cat-grid">
      ${categories.map(c => {
        const count = products.filter(p => p.category_id === c.id).length;
        return `<div class="cat-tile" onclick="openCategory('${c.id}')">
          <div class="cat-icon">${esc(c.icon || '📦')}</div>
          <div class="cat-name">${esc(c.name)}</div>
          <div class="cat-count">${count} item${count !== 1 ? 's' : ''}</div>
        </div>`;
      }).join('')}
    </div>`;
}
function renderSearchResults() {
  const q = shopSearchQuery.trim().toLowerCase();
  const matches = products.filter(p => (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
  if (!matches.length) return `<div class="empty"><div class="empty-icon"><i data-lucide="search-x" style="width:30px;height:30px"></i></div><h3>No matches</h3><p>Try a different search term.</p></div>`;
  return `<div class="section-title">${matches.length} result${matches.length !== 1 ? 's' : ''} for "${esc(shopSearchQuery.trim())}"</div>` + matches.map(p => renderProductCard(p, true)).join('');
}
function onShopSearchInput(value) {
  shopSearchQuery = value;
  // Re-render just the content area (not the whole shell) to keep focus in the input.
  const html = renderCategoryGrid();
  const mEl = document.getElementById('mContent'), dEl = document.getElementById('dContent');
  if (mEl) mEl.innerHTML = html;
  if (dEl) dEl.innerHTML = html;
  if (window.lucide) lucide.createIcons();
  // Restore focus + cursor position since innerHTML replacement resets it.
  const input = document.getElementById('shopSearchInput');
  if (input) { input.focus(); input.setSelectionRange(value.length, value.length); }
}
function clearShopSearch() {
  shopSearchQuery = '';
  onShopSearchInput('');
}
function openCategory(id) {
  currentCategory = categories.find(c => c.id === id);
  const html = renderProductList();
  document.getElementById('mContent').innerHTML = html;
  document.getElementById('dContent').innerHTML = html;
  if (window.lucide) lucide.createIcons();
}
function backToCategories() {
  currentCategory = null;
  goTab('shop');
}

// ── PRODUCT LIST ───────────────────────────────────────────────
function renderProductList() {
  const list = products.filter(p => p.category_id === currentCategory.id);
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <button class="btn bg bi" onclick="backToCategories()"><i data-lucide="arrow-left" style="width:15px;height:15px"></i></button>
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:700">${esc(currentCategory.icon)} ${esc(currentCategory.name)}</div>
      </div>
    </div>
    ${!list.length ? `<div class="empty"><div class="empty-icon"><i data-lucide="package-x" style="width:30px;height:30px"></i></div><h3>Nothing here yet</h3><p>No products in this category right now.</p></div>` :
      list.map(p => renderProductCard(p)).join('')}
  `;
}

function renderProductCard(p, showCategoryTag) {
  const tiers = p.product_price_tiers || [];
  const cheapest = cheapestTier(tiers);
  const inCart = cart.find(i => i.product_id === p.id);
  const qty = inCart ? inCart.qty : 1;
  const stockBadge = p.stock_count <= 0 ? `<span class="badge b-outstock"><span class="bdot"></span>Out of stock</span>`
    : p.stock_count <= p.low_stock_threshold ? `<span class="badge b-lowstock"><span class="bdot"></span>${p.stock_count} left</span>`
    : `<span class="badge b-instock"><span class="bdot"></span>In stock</span>`;
  const category = showCategoryTag ? categories.find(c => c.id === p.category_id) : null;

  return `
  <div class="prod-card" id="prod-${p.id}">
    <div class="prod-head">
      <div>
        ${category ? `<div class="fhint" style="margin-bottom:2px">${esc(category.icon)} ${esc(category.name)}</div>` : ''}
        <div class="prod-name">${esc(p.name)}</div>
        ${p.description ? `<div class="prod-desc">${esc(p.description)}</div>` : ''}
      </div>
      <div style="text-align:right">
        ${cheapest ? `<span class="prod-price-from">from</span><div class="prod-price">${money(tierUnitPrice(cheapest))}</div>` : `<div class="prod-price" style="color:var(--txt3);font-size:12px">No pricing set</div>`}
      </div>
    </div>
    <div style="margin-bottom:6px">${stockBadge}</div>
    ${tiers.length > 1 ? `<div class="tier-list">${tiers.map(t => `<span class="tier-chip">${t.min_qty}+ ${p.unit_label || 'unit'}${t.min_qty > 1 ? 's' : ''}: ${money(t.price)}</span>`).join('')}</div>` : ''}
    ${p.stock_count > 0 ? `
    <div class="prod-foot">
      <div class="qty-stepper">
        <button class="qty-btn" onclick="stepProductQty('${p.id}',-1)">−</button>
        <span class="qty-val" id="qtyval-${p.id}">${qty}</span>
        <button class="qty-btn" onclick="stepProductQty('${p.id}',1)">+</button>
      </div>
      <button class="btn bp bs" onclick="addProductToCart('${p.id}')"><i data-lucide="plus" style="width:13px;height:13px"></i>Add</button>
    </div>` : `
    <button class="btn bpurple bs full" onclick="startRestockPreorder('${p.id}')"><i data-lucide="bell" style="width:13px;height:13px"></i>Pre-order this instead</button>
    `}
  </div>`;
}

const productQtyState = {};
function stepProductQty(productId, delta) {
  const current = productQtyState[productId] || 1;
  const next = Math.max(1, current + delta);
  productQtyState[productId] = next;
  const el = document.getElementById(`qtyval-${productId}`);
  if (el) el.textContent = next;
}
function addProductToCart(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  const qty = productQtyState[productId] || 1;
  addToCart(product, qty);
  productQtyState[productId] = 1;
  const el = document.getElementById(`qtyval-${productId}`);
  if (el) el.textContent = 1;
}

// ── CART (tab + modal, sharing the same body renderer) ────────────
function renderCartPage() {
  return `<div class="section-title">Your Cart</div>${renderCartBody(false)}`;
}
function openCartModal() {
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="cartOverlay" onclick="if(event.target===this)closeModal('cartOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">Your Cart</span><button class="mclose" onclick="closeModal('cartOverlay')">&times;</button></div>
        <div id="cartModalBody">${renderCartBody(true)}</div>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}
function renderCartBody(inModal) {
  if (!cart.length) return `<div class="empty"><div class="empty-icon"><i data-lucide="shopping-cart" style="width:30px;height:30px"></i></div><h3>Your cart is empty</h3><p>Browse categories to add items.</p></div>`;
  const rows = cart.map(item => {
    const product = products.find(p => p.id === item.product_id);
    if (!product) return '';
    const lineTotal = priceForQty(product.product_price_tiers, item.qty);
    const tier = matchTier(product.product_price_tiers, item.qty);
    return `<div class="cart-item">
      <div>
        <div class="cart-item-name">${esc(product.name)}</div>
        <div class="cart-item-meta">
          <div class="qty-stepper" style="display:inline-flex;margin-top:4px">
            <button class="qty-btn" onclick="updateCartQty('${product.id}',${item.qty - 1})">−</button>
            <span class="qty-val">${item.qty}</span>
            <button class="qty-btn" onclick="updateCartQty('${product.id}',${item.qty + 1})">+</button>
          </div>
        </div>
      </div>
      <div class="cart-item-price">${money(lineTotal)}</div>
    </div>`;
  }).join('');
  const checkoutBtn = inModal
    ? `<button class="btn bp full" style="margin-top:16px" onclick="switchModal('cartOverlay', openCheckoutModal)">Checkout <i data-lucide="arrow-right" style="width:14px;height:14px"></i></button>`
    : `<button class="btn bp full" style="margin-top:16px" onclick="openCheckoutModal()">Checkout <i data-lucide="arrow-right" style="width:14px;height:14px"></i></button>`;
  return `
    ${rows}
    ${config.delivery_fee > 0 ? `<div class="cart-item"><div class="cart-item-name">Delivery fee</div><div class="cart-item-price">${money(config.delivery_fee)}</div></div>` : ''}
    <div class="cart-total-row"><span>Total</span><span>${money(cartTotal())}</span></div>
    ${config.min_order_value > 0 && cartTotal() < config.min_order_value ? `<div class="fhint" style="color:var(--amber);margin-top:8px">Minimum order is ${money(config.min_order_value)}.</div>` : ''}
    ${checkoutBtn}
  `;
}
function renderCartModal() {
  const body = document.getElementById('cartModalBody');
  if (body) body.innerHTML = renderCartBody(true);
  if (window.lucide) lucide.createIcons();
}
let _modalWipeTimer = null;
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
  // Cancel any previously-scheduled wipe before scheduling a new one — otherwise
  // a stale wipe (from a modal that's since been replaced by a new one, e.g.
  // cart → checkout) can fire after the new modal has already been rendered
  // into the same #modalRoot, deleting it right after it appears.
  if (_modalWipeTimer) clearTimeout(_modalWipeTimer);
  _modalWipeTimer = setTimeout(() => {
    // Only wipe if nothing else has re-opened a modal in the meantime.
    if (!document.querySelector('#modalRoot .overlay.open')) {
      document.getElementById('modalRoot').innerHTML = '';
    }
    _modalWipeTimer = null;
  }, 200);
}
function switchModal(closeId, openFn) {
  // Use this instead of chaining closeModal(x); openFn() directly in onclick
  // handlers — it cancels the old modal's pending wipe immediately since
  // we're replacing #modalRoot's content right away, then opens the next
  // modal on the next frame so its "open" transition still animates in.
  if (_modalWipeTimer) { clearTimeout(_modalWipeTimer); _modalWipeTimer = null; }
  const el = document.getElementById(closeId);
  if (el) el.classList.remove('open');
  requestAnimationFrame(openFn);
}

// ── CHECKOUT MODAL ─────────────────────────────────────────────
function openCheckoutModal() {
  if (!cart.length) { toast('Your cart is empty', 'warn'); return; }
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="checkoutOverlay" onclick="if(event.target===this)closeModal('checkoutOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">Checkout</span><button class="mclose" onclick="closeModal('checkoutOverlay')">&times;</button></div>
        <div id="checkoutModalBody">${isSignedIn() ? renderCheckoutForm() : renderCheckoutSignInGate()}</div>
      </div>
    </div>`;
  if (isSignedIn()) wireCheckoutFormEvents();
  if (window.lucide) lucide.createIcons();
}

// Sign-in is required only at this final step — browsing, cart, and
// pre-orders never require it. Once verified, the same modal swaps
// straight into the checkout form without losing the cart.
function renderCheckoutSignInGate() {
  return `
    <p class="fhint" style="margin-bottom:14px">Sign in to complete checkout — this keeps your order history synced across devices. It's only needed here; browsing and requests never require it.</p>
    <div id="checkoutSignInArea">${renderSignInStep()}</div>
  `;
}
function refreshCheckoutModalAfterAuth() {
  // Called after a successful sign-in that happened inside the checkout
  // modal specifically (as opposed to the Account tab's own sign-in flow).
  const body = document.getElementById('checkoutModalBody');
  if (body) { body.innerHTML = renderCheckoutForm(); wireCheckoutFormEvents(); if (window.lucide) lucide.createIcons(); }
}

function renderCheckoutForm() {
  const c = customerContact || {};
  return `
        <div class="fg"><label class="fl">Name</label><input class="fi" id="coName" placeholder="Your name" value="${esc(c.name || '')}"></div>
        <div class="fg"><label class="fl">Phone</label><input class="fi" id="coPhone" type="tel" placeholder="0801..." value="${esc(c.phone || '')}"></div>
        <div class="fhint" style="margin:-6px 0 12px">Signed in as ${esc(c.email || '')} — order updates go here automatically.</div>

        <div class="fg">
          <label class="fl">Notify me via</label>
          <div class="ngroup" id="notifPrefGroup">
            ${['email','sms','push','telegram'].map(ch => `<label class="nopt ${ch==='email'?'sel':''}" data-ch="${ch}"><input type="checkbox" ${ch==='email'?'checked':''}>${ch[0].toUpperCase()+ch.slice(1)}</label>`).join('')}
          </div>
        </div>

        <div class="fg">
          <label class="fl">When would you like this?</label>
          <div class="seg" style="margin-bottom:8px">
            <button type="button" class="seg-tab active" id="segAsap" onclick="setOrderTiming('asap')">ASAP</button>
            <button type="button" class="seg-tab" id="segLater" onclick="setOrderTiming('later')">Schedule for later</button>
          </div>
          <input class="fi" id="coScheduled" type="datetime-local" style="display:none">
          <div class="fhint">Scheduled orders need at least ${config.min_lead_time_hours}h notice.</div>
        </div>

        <div class="fg">
          <label class="fl">Payment</label>
          <div class="seg">
            <button type="button" class="seg-tab active" id="segPickup" onclick="setPayMethod('pay_on_pickup')">Pay on pickup</button>
            ${config.paystack_enabled ? `<button type="button" class="seg-tab" id="segOnline" onclick="setPayMethod('pay_online')">Pay online</button>` : ''}
          </div>
        </div>

        <div class="cart-total-row"><span>Total</span><span>${money(cartTotal())}</span></div>
        <button class="btn bp full" style="margin-top:16px" id="placeOrderBtn" onclick="submitCatalogOrder()">Place Order</button>
  `;
}
function wireCheckoutFormEvents() {
  document.querySelectorAll('#notifPrefGroup .nopt').forEach(el => {
    el.addEventListener('click', () => { el.classList.toggle('sel'); el.querySelector('input').checked = el.classList.contains('sel'); });
  });
}
let orderTiming = 'asap', orderPayMethod = 'pay_on_pickup';
function setOrderTiming(t) {
  orderTiming = t;
  document.getElementById('segAsap').classList.toggle('active', t === 'asap');
  document.getElementById('segLater').classList.toggle('active', t === 'later');
  document.getElementById('coScheduled').style.display = t === 'later' ? 'block' : 'none';
}
function setPayMethod(m) {
  orderPayMethod = m;
  const pickup = document.getElementById('segPickup'), online = document.getElementById('segOnline');
  if (pickup) pickup.classList.toggle('active', m === 'pay_on_pickup');
  if (online) online.classList.toggle('active', m === 'pay_online');
}

async function submitCatalogOrder() {
  if (!isSignedIn()) { toast('Please sign in to complete checkout', 'error'); return; }
  const name = document.getElementById('coName').value.trim();
  const phone = document.getElementById('coPhone').value.trim();
  const scheduledEl = document.getElementById('coScheduled');
  const scheduled_for = orderTiming === 'later' && scheduledEl.value ? new Date(scheduledEl.value).toISOString() : null;
  if (orderTiming === 'later' && !scheduled_for) { toast('Please pick a date and time', 'error'); return; }

  const selectedChannels = [...document.querySelectorAll('#notifPrefGroup .nopt.sel')].map(el => el.dataset.ch);
  const notify_preference = selectedChannels.join(',') || 'email';

  const items = cart.map(i => ({ product_id: i.product_id, quantity: i.qty }));
  const btn = document.getElementById('placeOrderBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Placing order...';

  try {
    // email is not sent — the backend derives identity from the signed-in
    // session's verified token (requireAuth), not from freeform form fields.
    const result = await api('/orders/catalog', 'POST', { name, phone, items, payment_method: orderPayMethod, scheduled_for, notify_preference });
    customerContact = { ...(customerContact || {}), name: name || customerContact?.name, phone: phone || customerContact?.phone };
    customerId = result.customer_id;
    localStorage.setItem('qs_contact', JSON.stringify(customerContact));
    localStorage.setItem('qs_customer_id', customerId);
    cart = [];
    saveCart();
    closeModal('checkoutOverlay');

    if (result.adjusted && result.adjusted.length) {
      const msgs = result.adjusted.map(a => a.reason === 'out_of_stock' ? `${a.name} was out of stock and removed` : a.reason === 'reduced_qty' ? `${a.name} reduced to ${a.available} (requested ${a.requested})` : `An item was no longer available and removed`);
      toast(msgs.join('; '), 'warn');
    }
    toast(orderPayMethod === 'pay_online' ? 'Order placed — awaiting payment confirmation' : 'Order confirmed! 🎉', 'success');
    goTab('orders');
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = 'Place Order';
  }
}

// ── RESTOCK PRE-ORDER (from out-of-stock product) ────────────────
function startRestockPreorder(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  goTab('preorder');
  setTimeout(() => {
    document.getElementById('preType-restock')?.click();
    const sel = document.getElementById('preRestockProduct');
    if (sel) sel.value = productId;
    updateRestockPriceHint();
  }, 50);
}

// ── PRE-ORDER FORM (restock / custom) ─────────────────────────────
function renderPreorderForm() {
  const c = customerContact || {};
  return `
    <div class="section-title">Request an Item</div>
    <p class="fhint" style="margin-bottom:14px">Can't find what you need, or it's out of stock? Tell us what you're after — we'll review and confirm pricing.</p>

    <div class="seg" style="margin-bottom:16px">
      <button type="button" class="seg-tab active" id="preType-restock" onclick="setPreorderType('restock')">Restock an item</button>
      <button type="button" class="seg-tab" id="preType-custom" onclick="setPreorderType('custom')">Something new</button>
    </div>

    <div id="preRestockSection">
      <div class="fg">
        <label class="fl">Which product?</label>
        <select class="fi" id="preRestockProduct" onchange="updateRestockPriceHint()">
          <option value="">Select a product...</option>
          ${products.map(p => `<option value="${p.id}">${esc(p.name)} ${p.stock_count <= 0 ? '(out of stock)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="fr">
        <div class="fg"><label class="fl">Quantity</label><input class="fi" id="preRestockQty" type="number" min="1" value="1" oninput="updateRestockPriceHint()"></div>
        <div class="fg"><label class="fl">Your price offer</label><input class="fi" id="preRestockPrice" type="number" min="0" placeholder="Suggested"></div>
      </div>
      <div class="fhint" id="restockPriceHint" style="margin:-6px 0 12px"></div>
    </div>

    <div id="preCustomSection" style="display:none">
      <div class="fg">
        <label class="fl">Category (optional)</label>
        <select class="fi" id="preCustomCategory">
          <option value="">Not sure / general</option>
          ${categories.map(c2 => `<option value="${c2.id}">${esc(c2.icon)} ${esc(c2.name)}</option>`).join('')}
        </select>
      </div>
      <div class="fg"><label class="fl">What would you like?</label><textarea class="fi" id="preCustomDesc" placeholder="Describe the item(s) you're looking for..."></textarea></div>
      <div class="fr">
        <div class="fg"><label class="fl">Quantity</label><input class="fi" id="preCustomQty" type="number" min="1" value="1"></div>
        <div class="fg"><label class="fl">Your price offer</label><input class="fi" id="preCustomPrice" type="number" min="0" placeholder="e.g. 1500"></div>
      </div>
    </div>

    <div class="divider"></div>
    <div class="fg"><label class="fl">Name</label><input class="fi" id="preName" placeholder="Your name" value="${esc(c.name || '')}"></div>
    <div class="fr">
      <div class="fg"><label class="fl">Email</label><input class="fi" id="preEmail" type="email" value="${esc(c.email || '')}"></div>
      <div class="fg"><label class="fl">Phone</label><input class="fi" id="prePhone" type="tel" value="${esc(c.phone || '')}"></div>
    </div>

    <div class="fg">
      <label class="fl">When do you need it?</label>
      <div class="seg" style="margin-bottom:8px">
        <button type="button" class="seg-tab active" id="preSegAsap" onclick="setPreorderTiming('asap')">Whenever available</button>
        <button type="button" class="seg-tab" id="preSegLater" onclick="setPreorderTiming('later')">Specific date</button>
      </div>
      <input class="fi" id="preScheduled" type="datetime-local" style="display:none">
    </div>

    <button class="btn bpurple full" style="margin-top:8px" id="submitPreorderBtn" onclick="submitPreorder()"><i data-lucide="send" style="width:14px;height:14px"></i>Submit Request</button>
  `;
}
let preorderType = 'restock', preorderTiming = 'asap';
function setPreorderType(t) {
  preorderType = t;
  document.getElementById('preType-restock').classList.toggle('active', t === 'restock');
  document.getElementById('preType-custom').classList.toggle('active', t === 'custom');
  document.getElementById('preRestockSection').style.display = t === 'restock' ? 'block' : 'none';
  document.getElementById('preCustomSection').style.display = t === 'custom' ? 'block' : 'none';
}
function setPreorderTiming(t) {
  preorderTiming = t;
  document.getElementById('preSegAsap').classList.toggle('active', t === 'asap');
  document.getElementById('preSegLater').classList.toggle('active', t === 'later');
  document.getElementById('preScheduled').style.display = t === 'later' ? 'block' : 'none';
}
function updateRestockPriceHint() {
  const productId = document.getElementById('preRestockProduct').value;
  const qty = parseInt(document.getElementById('preRestockQty').value) || 1;
  const hint = document.getElementById('restockPriceHint');
  const product = products.find(p => p.id === productId);
  if (!product) { hint.textContent = ''; return; }
  const price = priceForQty(product.product_price_tiers, qty);
  hint.textContent = price > 0 ? `Catalog price for ${qty}: ${money(price)} — feel free to adjust your offer above.` : 'No catalog pricing set for this item — please suggest a price.';
  const priceInput = document.getElementById('preRestockPrice');
  if (priceInput && !priceInput.value && price > 0) priceInput.placeholder = String(price);
}

async function submitPreorder() {
  const name = document.getElementById('preName').value.trim();
  const email = document.getElementById('preEmail').value.trim();
  const phone = document.getElementById('prePhone').value.trim();
  if (!email && !phone) { toast('Please provide an email or phone number', 'error'); return; }

  const scheduledEl = document.getElementById('preScheduled');
  const scheduled_for = preorderTiming === 'later' && scheduledEl.value ? new Date(scheduledEl.value).toISOString() : null;

  const btn = document.getElementById('submitPreorderBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Submitting...';

  try {
    let result;
    if (preorderType === 'restock') {
      const product_id = document.getElementById('preRestockProduct').value;
      if (!product_id) { toast('Please select a product', 'error'); btn.disabled = false; btn.innerHTML = 'Submit Request'; return; }
      const quantity = parseInt(document.getElementById('preRestockQty').value) || 1;
      const suggested_price = document.getElementById('preRestockPrice').value || null;
      result = await api('/orders/preorder/restock', 'POST', { name, email, phone, product_id, quantity, suggested_price, scheduled_for });
    } else {
      const description = document.getElementById('preCustomDesc').value.trim();
      if (!description) { toast("Please describe what you'd like", 'error'); btn.disabled = false; btn.innerHTML = 'Submit Request'; return; }
      const category_id = document.getElementById('preCustomCategory').value || null;
      const quantity = parseInt(document.getElementById('preCustomQty').value) || 1;
      const suggested_price = document.getElementById('preCustomPrice').value || null;
      result = await api('/orders/preorder/custom', 'POST', { name, email, phone, category_id, description, quantity, suggested_price, scheduled_for });
    }
    customerContact = { name, email, phone };
    customerId = result.order.customer_id || customerId;
    localStorage.setItem('qs_contact', JSON.stringify(customerContact));
    if (customerId) localStorage.setItem('qs_customer_id', customerId);
    toast("Request submitted! We'll review and confirm pricing.", 'success');
    goTab('orders');
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = '<i data-lucide="send" style="width:14px;height:14px"></i>Submit Request';
    if (window.lucide) lucide.createIcons();
  }
}

// ── ORDERS PAGE ────────────────────────────────────────────────
function renderOrdersPage() {
  const c = customerContact || {};
  if (!isSignedIn() && !c.email && !c.phone) {
    return `
      <div class="section-title">My Orders</div>
      <div class="card" style="padding:18px">
        <p class="fhint" style="margin-bottom:12px">Enter your email or phone to look up a guest order or pre-order request, or sign in from the Account tab to see your orders automatically.</p>
        <div class="fr">
          <div class="fg"><label class="fl">Email</label><input class="fi" id="lookupEmail" type="email"></div>
          <div class="fg"><label class="fl">Phone</label><input class="fi" id="lookupPhone" type="tel"></div>
        </div>
        <button class="btn bp full" onclick="lookupOrders()">Find My Orders</button>
      </div>`;
  }
  return `<div class="section-title">My Orders</div><div id="ordersList"><div class="empty"><div class="spin" style="margin:0 auto"></div></div></div>`;
}
async function lookupOrders() {
  const email = document.getElementById('lookupEmail').value.trim();
  const phone = document.getElementById('lookupPhone').value.trim();
  if (!email && !phone) { toast('Enter an email or phone', 'error'); return; }
  try {
    const result = await api('/orders/lookup', 'POST', { email, phone });
    customerContact = { ...(customerContact || {}), email, phone };
    localStorage.setItem('qs_contact', JSON.stringify(customerContact));
    if (result.customer_id) { customerId = result.customer_id; localStorage.setItem('qs_customer_id', customerId); }
    orders = result.orders || [];
    renderOrdersList();
  } catch (e) { toast(e.message, 'error'); }
}
async function loadOrders() {
  const c = customerContact || {};
  if (!isSignedIn() && !c.email && !c.phone) return;

  const cached = cacheGet('orders');
  if (cached) { orders = cached; renderOrdersList(); }

  if (!isOnline) return; // don't fire a request we know will fail; cached data (if any) stays on screen

  try {
    // While signed in, api() attaches the session token and the backend
    // resolves orders via the authenticated customer first — email/phone
    // in the body are only a fallback for guests.
    const result = await api('/orders/lookup', 'POST', { email: c.email, phone: c.phone });
    orders = result.orders || [];
    cacheSet('orders', orders);
    renderOrdersList();
  } catch (e) {
    // Fetch failed — keep cached orders on screen if we have them;
    // only fall through to the empty state if there's truly nothing.
    if (!cached) renderOrdersList();
  }
}
function renderOrdersList() {
  const el = document.getElementById('ordersList');
  if (!el) return;
  if (!orders.length) { el.innerHTML = `<div class="empty"><div class="empty-icon"><i data-lucide="package-x" style="width:30px;height:30px"></i></div><h3>No orders yet</h3><p>Your orders will show up here.</p></div>`; if (window.lucide) lucide.createIcons(); return; }
  el.innerHTML = orders.map(o => renderOrderCard(o)).join('');
  if (window.lucide) lucide.createIcons();
}
function orderTypeLabel(type) { return { catalog: 'Shop order', restock_preorder: 'Restock request', custom_preorder: 'Custom request' }[type] || type; }
function orderStatusBadge(status) {
  const map = { pending: 'b-pending', confirmed: 'b-confirmed', fulfilled: 'b-fulfilled', rejected: 'b-rejected', cancelled: 'b-cancelled' };
  return `<span class="badge ${map[status] || 'b-pending'}"><span class="bdot"></span>${status}</span>`;
}
function renderOrderCard(o) {
  const itemCount = (o.order_items || []).length;
  const summary = (o.order_items || []).slice(0, 2).map(i => `${i.quantity}× ${i.description}`).join(', ') + (itemCount > 2 ? ` +${itemCount - 2} more` : '');
  return `
  <div class="order-card" onclick="openOrderDetail('${o.id}')">
    <div class="order-head">
      <span class="order-id">#${o.id.slice(0, 8)}</span>
      ${o.type !== 'catalog' ? `<span class="badge b-custom">${orderTypeLabel(o.type)}</span>` : ''}
      <span class="order-date">${new Date(o.created_at).toLocaleDateString()}</span>
    </div>
    <div class="order-summary">${esc(summary)}</div>
    ${o.scheduled_for ? `<div class="fhint" style="margin-bottom:6px"><i data-lucide="calendar-clock" style="width:11px;height:11px;vertical-align:middle"></i> Scheduled: ${new Date(o.scheduled_for).toLocaleString()}</div>` : ''}
    <div class="order-foot">
      ${orderStatusBadge(o.status)}
      <span class="order-total">${money(o.total_amount)}</span>
    </div>
  </div>`;
}
function orderTimelineSteps(o) {
  if (o.status === 'rejected' || o.status === 'cancelled') {
    return [{ label: 'Placed', state: 'done' }, { label: o.status === 'rejected' ? 'Rejected' : 'Cancelled', state: 'rejected' }];
  }
  const steps = [{ label: 'Placed', state: 'done' }];
  steps.push({ label: o.type === 'catalog' ? 'Confirmed' : 'Priced', state: o.status === 'pending' ? 'active' : 'done' });
  steps.push({ label: 'Fulfilled', state: o.status === 'fulfilled' ? 'done' : (o.status === 'confirmed' ? 'active' : '') });
  return steps;
}
function renderTimeline(o) {
  const steps = orderTimelineSteps(o);
  return `<div class="timeline">${steps.map(s => `
    <div class="tl-step ${s.state}">
      <div class="tl-line"></div>
      <div class="tl-dot">${s.state === 'done' ? '✓' : s.state === 'rejected' ? '✕' : ''}</div>
      <div class="tl-label">${s.label}</div>
    </div>`).join('')}</div>`;
}
function openOrderDetail(orderId) {
  const o = orders.find(x => x.id === orderId);
  if (!o) return;
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="orderDetailOverlay" onclick="if(event.target===this)closeModal('orderDetailOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">Order #${o.id.slice(0,8)}</span><button class="mclose" onclick="closeModal('orderDetailOverlay')">&times;</button></div>
        ${renderTimeline(o)}
        <div class="divider"></div>
        ${(o.order_items || []).map(i => `
          <div class="cart-item">
            <div>
              <div class="cart-item-name">${esc(i.description)} <span class="fhint">×${i.quantity}</span></div>
              ${i.customer_suggested_price != null ? `<div class="cart-item-meta">You offered: ${money(i.customer_suggested_price)}</div>` : ''}
              ${i.line_status && i.line_status !== 'accepted' ? `<div class="cart-item-meta">${orderStatusBadge(i.line_status)}</div>` : ''}
            </div>
            <div class="cart-item-price">${i.admin_price != null ? money(i.admin_price) : '—'}</div>
          </div>`).join('')}
        <div class="cart-total-row"><span>Total</span><span>${money(o.total_amount)}</span></div>
        ${o.type === 'catalog' && o.status !== 'cancelled' ? `<button class="btn bg full" style="margin-top:14px" onclick="reorderOrder('${o.id}')"><i data-lucide="repeat" style="width:14px;height:14px"></i>Reorder</button>` : ''}
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}
async function reorderOrder(orderId) {
  try {
    const result = await api(`/orders/${orderId}/reorder`, 'POST', {});
    closeModal('orderDetailOverlay');
    toast('Reordered! Check your orders for the new one.', 'success');
    loadOrders();
  } catch (e) { toast(e.message, 'error'); }
}

// ── ACCOUNT PAGE ───────────────────────────────────────────────
function renderAccountPage() {
  const c = customerContact || {};
  const themeCard = `
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="font-weight:600;font-size:13px">Appearance</div>
        <div class="seg" style="margin:0">
          <button type="button" class="seg-tab" id="themeTabDark" onclick="setAppTheme('dark')">🌙 Dark</button>
          <button type="button" class="seg-tab" id="themeTabLight" onclick="setAppTheme('light')">☀️ Light</button>
        </div>
      </div>
    </div>`;

  const signInCard = isSignedIn() ? `
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
        <div style="font-weight:600">${esc(c.name || c.email || 'Signed in')}</div>
        <span class="badge b-instock"><span class="bdot"></span>Signed in</span>
      </div>
      ${c.email ? `<div class="fhint">${esc(c.email)}</div>` : ''}
      ${c.phone ? `<div class="fhint">${esc(c.phone)}</div>` : ''}
      <button class="btn bg bs" style="margin-top:10px" onclick="signOut()"><i data-lucide="log-out" style="width:13px;height:13px"></i>Sign Out</button>
    </div>` : `
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:4px;font-size:13px">Sign in</div>
      <p class="fhint" style="margin-bottom:12px">Sign in to sync your orders across devices. You can browse and submit requests without signing in — it's only needed to complete checkout.</p>
      <div id="signInFormArea">${renderSignInStep()}</div>
    </div>`;

  if (!isSignedIn() && !c.email && !c.phone) {
    return `<div class="section-title">Account</div>${signInCard}${themeCard}`;
  }
  return `
    <div class="section-title">Account</div>
    ${signInCard}
    ${themeCard}
    ${!isSignedIn() ? `
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:2px">${esc(c.name || 'Guest')}</div>
      ${c.email ? `<div class="fhint">${esc(c.email)}</div>` : ''}
      ${c.phone ? `<div class="fhint">${esc(c.phone)}</div>` : ''}
      <div class="fhint" style="margin-top:6px">Saved from a previous guest order or request on this device.</div>
    </div>` : ''}

    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:10px;font-size:13px">Notification Channels</div>
      <div class="ngroup" id="accountNotifGroup">
        ${['email','sms','push','telegram'].map(ch => `<label class="nopt" data-ch="${ch}"><input type="checkbox">${ch[0].toUpperCase()+ch.slice(1)}</label>`).join('')}
      </div>
      <button class="btn bp bs" style="margin-top:12px" onclick="saveNotifPrefs()">Save Preferences</button>
    </div>

    ${config.telegram_enabled ? `
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:8px;font-size:13px">Link Telegram</div>
      <p class="fhint" style="margin-bottom:10px">Message our Telegram bot${config.telegram_bot_username ? ` @${config.telegram_bot_username}` : ''} with /start to get a linking code.</p>
      <div class="fr">
        <input class="fi" id="tgCode" placeholder="6-digit code">
        <button class="btn bg" onclick="linkTelegram()">Link</button>
      </div>
    </div>` : ''}

    <button class="btn bd full" onclick="clearAccountData()"><i data-lucide="log-out" style="width:14px;height:14px"></i>Forget My Info On This Device</button>
  `;
}

// ── SIGN-IN FLOW (email → 8-char code → session) ──────────────────
function renderSignInStep() {
  if (authPendingEmail) {
    return `
      <div class="fg"><label class="fl">Enter the code sent to ${esc(authPendingEmail)}</label><input class="fi" id="signInCodeInput" placeholder="8-character code" maxlength="8" style="text-transform:uppercase;letter-spacing:2px;font-family:'DM Mono',monospace" autofocus></div>
      <button class="btn bp full" id="verifyCodeBtn" onclick="submitVerifyCode()">Verify & Sign In</button>
      <button class="btn bg full" style="margin-top:8px" onclick="cancelSignIn()">Use a different email</button>
    `;
  }
  return `
    <div class="fg"><label class="fl">Email</label><input class="fi" id="signInEmailInput" type="email" placeholder="you@example.com"></div>
    <button class="btn bp full" id="requestCodeBtn" onclick="submitRequestCode()">Send Sign-In Code</button>
  `;
}
function activeSignInContainer() {
  return document.getElementById('checkoutSignInArea') || document.getElementById('signInFormArea');
}
async function submitRequestCode() {
  const email = document.getElementById('signInEmailInput').value.trim();
  if (!email) { toast('Enter your email', 'error'); return; }
  const btn = document.getElementById('requestCodeBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Sending...';
  try {
    await requestSignInCode(email);
    toast('Code sent — check your email', 'success');
    const area = activeSignInContainer();
    if (area) area.innerHTML = renderSignInStep();
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = 'Send Sign-In Code';
  }
}
async function submitVerifyCode() {
  const code = document.getElementById('signInCodeInput').value.trim();
  if (!code) { toast('Enter the code from your email', 'error'); return; }
  const btn = document.getElementById('verifyCodeBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Verifying...';
  const inCheckout = !!document.getElementById('checkoutSignInArea');
  try {
    await verifySignInCode(authPendingEmail, code);
    toast('Signed in!', 'success');
    if (inCheckout) refreshCheckoutModalAfterAuth();
    else goTab('account');
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = 'Verify & Sign In';
  }
}
function cancelSignIn() {
  authPendingEmail = null;
  const area = activeSignInContainer();
  if (area) area.innerHTML = renderSignInStep();
}

async function saveNotifPrefs() {
  const selected = [...document.querySelectorAll('#accountNotifGroup .nopt.sel')].map(el => el.dataset.ch);
  if (!customerId) { toast('Place an order first to create your profile', 'warn'); return; }
  try {
    await api(`/customer/${customerId}/preferences`, 'PUT', { notify_preference: selected.join(',') || 'email' });
    toast('Preferences saved', 'success');
  } catch (e) { toast(e.message, 'error'); }
}
async function linkTelegram() {
  const code = document.getElementById('tgCode').value.trim();
  if (!code) { toast('Enter the code from Telegram', 'error'); return; }
  if (!customerId) { toast('Place an order first to create your profile', 'warn'); return; }
  try { await api(`/customer/${customerId}/link-telegram`, 'POST', { code }); toast('Telegram linked!', 'success'); }
  catch (e) { toast(e.message, 'error'); }
}
function clearAccountData() {
  showConfirm('Forget your info?', 'This clears your saved name, email, and phone from this device. Your order history stays on our records and can be looked up again by email or phone.', () => {
    clearCustomerCache();
    localStorage.removeItem('qs_contact'); localStorage.removeItem('qs_customer_id');
    customerContact = null; customerId = null;
    toast('Cleared', 'success');
    goTab('account');
  });
}

// ── NOTIFICATIONS MODAL (hybrid historical cache) ─────────────────
// The server prunes notifications older than its retention window
// (see backend daily cleanup), so older entries are preserved here in
// localStorage and merged with fresh server data on every load. The
// merged result is de-duplicated by id, sorted newest first, and
// capped at NOTIF_CACHE_CAP entries so localStorage never grows unbounded.
function mergeNotifications(cached, fresh) {
  const byId = new Map();
  [...(cached || []), ...(fresh || [])].forEach(n => byId.set(n.id, n)); // fresh entries overwrite cached (e.g. is_read updates)
  return [...byId.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, NOTIF_CACHE_CAP);
}
async function refreshNotifications() {
  if (!customerId) return;
  const cached = cacheGet('notifications');
  if (cached) {
    notifications = cached;
    const hasUnread = notifications.some(n => !n.is_read);
    document.querySelectorAll('.notif-dot').forEach(el => el.classList.toggle('show', hasUnread));
  }
  if (!isOnline) return; // skip the network call entirely; cached notifications (if any) stay visible
  try {
    const fresh = await api(`/customer/notifications?customer_id=${customerId}`);
    notifications = mergeNotifications(cached, fresh);
    cacheSet('notifications', notifications);
    const hasUnread = notifications.some(n => !n.is_read);
    document.querySelectorAll('.notif-dot').forEach(el => el.classList.toggle('show', hasUnread));
  } catch (e) { /* offline or failed — cached notifications (if any) stay on screen */ }
}
function openNotifModal() {
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="notifOverlay" onclick="if(event.target===this)closeModal('notifOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">Notifications</span><button class="mclose" onclick="closeModal('notifOverlay')">&times;</button></div>
        ${!notifications.length ? `<div class="empty"><div class="empty-icon"><i data-lucide="bell-off" style="width:28px;height:28px"></i></div><h3>No notifications</h3></div>` :
          notifications.map(n => `<div class="cart-item" style="cursor:pointer" onclick="markNotifRead('${n.id}')">
            <div><div class="cart-item-name">${!n.is_read ? '<span style="color:var(--blue)">●</span> ' : ''}${esc(n.title)}</div><div class="cart-item-meta">${esc(n.message)}</div></div>
          </div>`).join('')}
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}
async function markNotifRead(id) {
  try { await api(`/customer/notifications/${id}/read`, 'PUT'); const n = notifications.find(x => x.id === id); if (n) n.is_read = true; refreshNotifications(); } catch {}
}

// ── CONFIRM DIALOG ──────────────────────────────────────────────
function showConfirm(title, msg, onConfirm) {
  const root = document.getElementById('modalRoot');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="confirmDlg" class="open">
      <div class="confirm-box">
        <div class="confirm-icon"><i data-lucide="alert-triangle" style="width:26px;height:26px;color:var(--amber)"></i></div>
        <div class="confirm-title">${esc(title)}</div>
        <div class="confirm-msg">${esc(msg)}</div>
        <div class="confirm-btns">
          <button class="btn bg full" id="confirmCancel">Cancel</button>
          <button class="btn bd full" id="confirmOk">Confirm</button>
        </div>
      </div>
    </div>`;
  root.appendChild(wrapper);
  if (window.lucide) lucide.createIcons();
  document.getElementById('confirmCancel').onclick = () => wrapper.remove();
  document.getElementById('confirmOk').onclick = () => { wrapper.remove(); onConfirm(); };
}

// ── notif chip toggle delegation for account page ────────────────
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.nopt');
  if (chip && chip.closest('#accountNotifGroup')) {
    chip.classList.toggle('sel');
    chip.querySelector('input').checked = chip.classList.contains('sel');
  }
});

// ── BOOT ───────────────────────────────────────────────────────
init();
