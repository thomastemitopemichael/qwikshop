// ═══════════════════════════════════════════════════════════════
// QuickShop — Customer App
// ═══════════════════════════════════════════════════════════════
// The native app shell injects window.QUICKSHOP_API_BASE before this
// script runs (WebView preload script / JS bridge global). There is no
// address bar in a WebView for a user to configure this, so we never
// read it from localStorage or prompt for it — only the injected value
// or a localhost fallback for local development.
const API_BASE = window.QUICKSHOP_API_BASE || 'http://localhost:4000/api';

// ── STATE ──────────────────────────────────────────────────────
let config = { shop_name: 'QuickShop', currency_symbol: '₦', min_lead_time_hours: 2, min_order_value: 0, delivery_fee: 0 };
let categories = [];
let products = [];
let cart = JSON.parse(localStorage.getItem('qs_cart') || '[]'); // [{product_id, name, qty, tiers}]
let customerId = localStorage.getItem('qs_customer_id') || null;
let customerContact = JSON.parse(localStorage.getItem('qs_contact') || 'null'); // {name, email, phone}
let notifications = [];
let currentCategory = null;
let currentTab = 'shop'; // shop | orders | preorder | account
let orders = [];

// ── API HELPERS ─────────────────────────────────────────────────
async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
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
  const badge = document.getElementById('cartCount');
  if (badge) { badge.textContent = cartCount(); badge.style.display = cartCount() > 0 ? 'flex' : 'none'; }
  const fab = document.getElementById('cartFab');
  if (fab) {
    if (cartCount() > 0) { fab.classList.remove('hidden'); document.getElementById('cartFabText').textContent = `${cartCount()} item${cartCount() !== 1 ? 's' : ''} · ${money(cartTotal())}`; }
    else fab.classList.add('hidden');
  }
}

// ── INIT ─────────────────────────────────────────────────────────
async function init() {
  try {
    config = await api('/config');
  } catch (e) { console.warn('Config load failed, using defaults', e); }
  try {
    categories = await api('/categories');
    products = await api('/products');
  } catch (e) { toast('Could not load shop data. Check your connection.', 'error'); }

  document.getElementById('app').innerHTML = renderShell();
  document.getElementById('app').style.display = 'block';
  setTimeout(() => { document.getElementById('splash').classList.add('hide'); }, 900);

  updateCartBadge();
  goTab('shop');
  if (window.lucide) lucide.createIcons();

  if (customerId) refreshNotifications();
}

// ── SHELL (mobile + desktop) ───────────────────────────────────
function renderShell() {
  return `
  <div class="m-shell m-only">
    <div class="m-top">
      <div class="m-logo"><i data-lucide="shopping-bag" style="width:20px;height:20px;color:var(--blue)"></i><span class="m-logo-txt">${esc(config.shop_name)}</span></div>
      <div class="m-top-r">
        <button class="notif-btn" onclick="openNotifModal()"><i data-lucide="bell" style="width:15px;height:15px"></i><span class="notif-dot" id="notifDotM"></span></button>
        <button class="cart-btn" onclick="openCartModal()"><i data-lucide="shopping-cart" style="width:15px;height:15px"></i><span class="cart-count" id="cartCount" style="display:none">0</span></button>
      </div>
    </div>
    <div class="m-content" id="mContent"></div>
    <div class="m-bot">
      <button class="m-nb act" data-tab="shop" onclick="goTab('shop')"><span class="m-ni"><i data-lucide="store" style="width:19px;height:19px"></i></span>Shop</button>
      <button class="m-nb" data-tab="preorder" onclick="goTab('preorder')"><span class="m-ni"><i data-lucide="clipboard-list" style="width:19px;height:19px"></i></span>Request</button>
      <button class="m-nb" data-tab="orders" onclick="goTab('orders')"><span class="m-ni"><i data-lucide="package" style="width:19px;height:19px"></i></span>Orders</button>
      <button class="m-nb" data-tab="account" onclick="goTab('account')"><span class="m-ni"><i data-lucide="user" style="width:19px;height:19px"></i></span>Account</button>
    </div>
    <div class="cart-fab hidden" id="cartFab" onclick="openCartModal()">
      <span><i data-lucide="shopping-cart" style="width:16px;height:16px;vertical-align:middle;margin-right:6px"></i><span id="cartFabText"></span></span>
      <i data-lucide="arrow-right" style="width:16px;height:16px"></i>
    </div>
  </div>

  <div class="d-shell d-only">
    <div class="d-side">
      <div class="d-logo"><i data-lucide="shopping-bag" style="width:22px;height:22px;color:var(--blue)"></i><span class="d-logo-txt">${esc(config.shop_name)}</span></div>
      <div class="d-nav">
        <div class="d-nitem act" data-tab="shop" onclick="goTab('shop')"><i data-lucide="store" style="width:16px;height:16px"></i>Shop</div>
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
          <button class="cart-btn" onclick="openCartModal()"><i data-lucide="shopping-cart" style="width:15px;height:15px"></i><span class="cart-count" id="cartCountD" style="display:none">0</span></button>
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
  const titles = { shop: 'Shop', preorder: 'Request an Item', orders: 'My Orders', account: 'Account' };
  const dTitle = document.getElementById('dTitle'); if (dTitle) dTitle.textContent = titles[tab];
  let html = '';
  if (tab === 'shop') html = currentCategory ? renderProductList() : renderCategoryGrid();
  else if (tab === 'preorder') html = renderPreorderForm();
  else if (tab === 'orders') html = renderOrdersPage();
  else if (tab === 'account') html = renderAccountPage();
  document.getElementById('mContent').innerHTML = html;
  document.getElementById('dContent').innerHTML = html;
  if (window.lucide) lucide.createIcons();
  if (tab === 'orders') loadOrders();
}

// ── CATEGORY GRID ──────────────────────────────────────────────
function renderCategoryGrid() {
  if (!categories.length) return `<div class="empty"><div class="empty-icon"><i data-lucide="store" style="width:34px;height:34px"></i></div><h3>No categories yet</h3><p>Check back soon.</p></div>`;
  return `
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

function renderProductCard(p) {
  const tiers = p.product_price_tiers || [];
  const cheapest = cheapestTier(tiers);
  const inCart = cart.find(i => i.product_id === p.id);
  const qty = inCart ? inCart.qty : 1;
  const stockBadge = p.stock_count <= 0 ? `<span class="badge b-outstock"><span class="bdot"></span>Out of stock</span>`
    : p.stock_count <= p.low_stock_threshold ? `<span class="badge b-lowstock"><span class="bdot"></span>${p.stock_count} left</span>`
    : `<span class="badge b-instock"><span class="bdot"></span>In stock</span>`;

  return `
  <div class="prod-card" id="prod-${p.id}">
    <div class="prod-head">
      <div>
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

// ── CART MODAL ───────────────────────────────────────────────────
function openCartModal() {
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="cartOverlay" onclick="if(event.target===this)closeModal('cartOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">Your Cart</span><button class="mclose" onclick="closeModal('cartOverlay')">&times;</button></div>
        <div id="cartModalBody">${renderCartBody()}</div>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}
function renderCartBody() {
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
  return `
    ${rows}
    ${config.delivery_fee > 0 ? `<div class="cart-item"><div class="cart-item-name">Delivery fee</div><div class="cart-item-price">${money(config.delivery_fee)}</div></div>` : ''}
    <div class="cart-total-row"><span>Total</span><span>${money(cartTotal())}</span></div>
    ${config.min_order_value > 0 && cartTotal() < config.min_order_value ? `<div class="fhint" style="color:var(--amber);margin-top:8px">Minimum order is ${money(config.min_order_value)}.</div>` : ''}
    <button class="btn bp full" style="margin-top:16px" onclick="closeModal('cartOverlay');openCheckoutModal()">Checkout <i data-lucide="arrow-right" style="width:14px;height:14px"></i></button>
  `;
}
function renderCartModal() {
  const body = document.getElementById('cartModalBody');
  if (body) body.innerHTML = renderCartBody();
  if (window.lucide) lucide.createIcons();
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('open'); setTimeout(() => { document.getElementById('modalRoot').innerHTML = ''; }, 200); }
}

// ── CHECKOUT MODAL ─────────────────────────────────────────────
function openCheckoutModal() {
  if (!cart.length) { toast('Your cart is empty', 'warn'); return; }
  const c = customerContact || {};
  document.getElementById('modalRoot').innerHTML = `
    <div class="overlay open" id="checkoutOverlay" onclick="if(event.target===this)closeModal('checkoutOverlay')">
      <div class="modal">
        <div class="mhead"><span class="mtitle">Checkout</span><button class="mclose" onclick="closeModal('checkoutOverlay')">&times;</button></div>
        <div class="fg"><label class="fl">Name</label><input class="fi" id="coName" placeholder="Your name" value="${esc(c.name || '')}"></div>
        <div class="fr">
          <div class="fg"><label class="fl">Email</label><input class="fi" id="coEmail" type="email" placeholder="you@example.com" value="${esc(c.email || '')}"></div>
          <div class="fg"><label class="fl">Phone</label><input class="fi" id="coPhone" type="tel" placeholder="0801..." value="${esc(c.phone || '')}"></div>
        </div>
        <div class="fhint" style="margin:-6px 0 12px">We need at least one of email or phone to send order updates.</div>

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
      </div>
    </div>`;
  document.querySelectorAll('#notifPrefGroup .nopt').forEach(el => {
    el.addEventListener('click', () => { el.classList.toggle('sel'); el.querySelector('input').checked = el.classList.contains('sel'); });
  });
  if (window.lucide) lucide.createIcons();
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
  const name = document.getElementById('coName').value.trim();
  const email = document.getElementById('coEmail').value.trim();
  const phone = document.getElementById('coPhone').value.trim();
  if (!email && !phone) { toast('Please provide an email or phone number', 'error'); return; }
  const scheduledEl = document.getElementById('coScheduled');
  const scheduled_for = orderTiming === 'later' && scheduledEl.value ? new Date(scheduledEl.value).toISOString() : null;
  if (orderTiming === 'later' && !scheduled_for) { toast('Please pick a date and time', 'error'); return; }

  const selectedChannels = [...document.querySelectorAll('#notifPrefGroup .nopt.sel')].map(el => el.dataset.ch);
  const notify_preference = selectedChannels.join(',') || 'email';

  const items = cart.map(i => ({ product_id: i.product_id, quantity: i.qty }));
  const btn = document.getElementById('placeOrderBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div> Placing order...';

  try {
    const result = await api('/orders/catalog', 'POST', { name, email, phone, items, payment_method: orderPayMethod, scheduled_for, notify_preference });
    customerContact = { name, email, phone };
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
  if (!c.email && !c.phone) {
    return `
      <div class="section-title">My Orders</div>
      <div class="card" style="padding:18px">
        <p class="fhint" style="margin-bottom:12px">Enter your email or phone to look up your orders.</p>
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
  if (!c.email && !c.phone) return;
  try {
    const result = await api('/orders/lookup', 'POST', { email: c.email, phone: c.phone });
    orders = result.orders || [];
    renderOrdersList();
  } catch (e) { /* silent on tab switch */ }
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
  if (!c.email && !c.phone) {
    return `<div class="section-title">Account</div><div class="empty"><div class="empty-icon"><i data-lucide="user" style="width:30px;height:30px"></i></div><h3>No account info yet</h3><p>Place an order or submit a request to set up your contact details.</p></div>`;
  }
  return `
    <div class="section-title">Account</div>
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:2px">${esc(c.name || 'Guest')}</div>
      ${c.email ? `<div class="fhint">${esc(c.email)}</div>` : ''}
      ${c.phone ? `<div class="fhint">${esc(c.phone)}</div>` : ''}
    </div>

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
    localStorage.removeItem('qs_contact'); localStorage.removeItem('qs_customer_id');
    customerContact = null; customerId = null;
    toast('Cleared', 'success');
    goTab('account');
  });
}

// ── NOTIFICATIONS MODAL ────────────────────────────────────────
async function refreshNotifications() {
  if (!customerId) return;
  try {
    notifications = await api(`/customer/notifications?customer_id=${customerId}`);
    const hasUnread = notifications.some(n => !n.is_read);
    document.querySelectorAll('.notif-dot').forEach(el => el.classList.toggle('show', hasUnread));
  } catch (e) { /* silent */ }
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
