/**
 * QuickShop Backend — v1.0.0
 * Category-based shop: catalog browsing with bulk/tiered pricing,
 * autonomous catalog ordering (auto-confirm + stock decrement),
 * restock & custom pre-orders (admin-priced), scheduled orders,
 * guest-first checkout, multi-channel notifications.
 */
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");
const crypto  = require("crypto");
const axios   = require("axios");

const { createClient } = require("@supabase/supabase-js");
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const supabaseAnon  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

// ── AFRICA'S TALKING SMS ─────────────────────────────────────────
const AfricasTalking = require("africastalking");
let _atSms = null;
function getAtSms() {
  if (_atSms) return _atSms;
  const apiKey = process.env.AT_API_KEY, username = process.env.AT_USERNAME;
  if (!apiKey || !username) return null;
  try { _atSms = AfricasTalking({ apiKey, username }).SMS; return _atSms; } catch { return null; }
}

// ── EMAIL ────────────────────────────────────────────────────────
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

// ── TELEGRAM BOT ─────────────────────────────────────────────────
const TelegramBot = require("node-telegram-bot-api");
let tgBot = null;
function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log("[Telegram] No TELEGRAM_BOT_TOKEN — Telegram disabled."); return; }
  try {
    tgBot = new TelegramBot(token, { polling: true });
    tgBot.on("message", async (msg) => {
      const chatId = String(msg.chat.id);
      const text = (msg.text || "").trim();
      if (text === "/start" || text.startsWith("/start ")) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await supabaseAdmin.from("telegram_link_codes").insert({ chat_id: chatId, code, expires_at: expiresAt });
        try {
          await tgBot.sendMessage(chatId,
            `🛍️ *QuickShop — Link Your Account*\n\nYour one-time linking code is:\n\n*${code}*\n\nEnter this code in the app → Settings → Link Telegram.\n_Code expires in 10 minutes._`,
            { parse_mode: "Markdown" });
        } catch (e) { console.error("[Telegram /start reply error]", e.message); }
      }
    });
    tgBot.on("polling_error", (err) => { if (!err.message?.includes("EFATAL")) console.error("[Telegram polling]", err.message); });
    console.log("[Telegram] Bot polling started.");
  } catch (e) { console.error("[Telegram] Failed to init bot:", e.message); }
}
async function sendTelegram(chatId, message) {
  if (!tgBot || !chatId) return { success: false, error: "Telegram not configured or no chat ID" };
  try { await tgBot.sendMessage(String(chatId), message, { parse_mode: "Markdown" }); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
}

const app = express();
const corsOpts = { origin: "*", methods: ["GET","POST","PUT","DELETE","OPTIONS","PATCH"], allowedHeaders: ["Content-Type","Authorization","x-admin-key"], optionsSuccessStatus: 200 };
app.use(cors(corsOpts));
app.options("*", cors(corsOpts));
app.use(express.json({ limit: "10mb" }));

let cronJobs = {};

// ── SETTINGS HELPERS ─────────────────────────────────────────────
async function getSetting(key) { const { data } = await supabaseAdmin.from("admin_settings").select("value").eq("key", key).single(); return data?.value || null; }
async function setSetting(key, value) { await supabaseAdmin.from("admin_settings").upsert({ key, value }, { onConflict: "key" }); }
async function getSettings() { const { data } = await supabaseAdmin.from("admin_settings").select("*"); const map = {}; (data||[]).forEach(r => { map[r.key] = r.value; }); return map; }

function prefHas(pref, channel) {
  if (!pref) return channel === "email";
  const s = String(pref).trim().toLowerCase();
  if (s === "all") return true;
  if (s.includes(",")) return s.split(",").map(x => x.trim()).includes(channel);
  return s === channel;
}
async function getAllowedChannels() {
  const s = await getSettings();
  const raw = (s.allowed_channels || "email,sms,push,telegram").trim();
  const list = raw.split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  return { email: list.includes("email"), sms: list.includes("sms"), push: list.includes("push"), telegram: list.includes("telegram"), list };
}
const fromEmail = () => process.env.FROM_EMAIL || "QuickShop <onboarding@resend.dev>";
async function sendEmailRaw(to, subject, html, text) { try { const r = await resend.emails.send({ from: fromEmail(), to: [to], subject, html, text }); return { success: true, id: r.data?.id }; } catch (err) { return { success: false, error: err.message }; } }

async function sendSms(phone, message) {
  const sms = getAtSms();
  if (!sms) return { success: false, error: "SMS not configured" };
  try {
    const result = await sms.send({ to: [phone], message, from: process.env.AT_SENDER_ID || undefined });
    const recipient = result?.SMSMessageData?.Recipients?.[0];
    if (recipient?.status === "Success" || recipient?.statusCode === 101) return { success: true, messageId: recipient?.messageId };
    return { success: false, error: recipient?.status || "Unknown AT error" };
  } catch (err) { return { success: false, error: err.message }; }
}

async function sendPush(customerId, title, body) {
  const appId = process.env.ONESIGNAL_APP_ID, apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) return { success: false, error: "OneSignal not configured" };
  try {
    const { data: devices } = await supabaseAdmin.from("customer_devices").select("subscription_id").eq("customer_id", customerId);
    const subIds = (devices || []).map(d => d.subscription_id).filter(Boolean);
    if (!subIds.length) return { success: false, error: "no_devices" };
    const r = await axios.post("https://onesignal.com/api/v1/notifications", {
      app_id: appId, include_subscription_ids: subIds, headings: { en: title }, contents: { en: body }
    }, { headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" } });
    return { success: true, id: r.data?.id };
  } catch (err) { return { success: false, error: err.response?.data?.errors?.[0] || err.message }; }
}

// ── CUSTOMER-FACING NOTIFICATION DISPATCH ────────────────────────
async function notifyCustomer(customerId, type, title, message) {
  try {
    await supabaseAdmin.from("notifications").insert({ customer_id: customerId, type, title, message });
    const { data: c } = await supabaseAdmin.from("customers").select("*").eq("id", customerId).single();
    if (!c) return;
    const allowed = await getAllowedChannels();
    const pref = c.notify_preference;
    if (allowed.email && prefHas(pref, "email") && c.email) {
      await sendEmailRaw(c.email, title, `<!DOCTYPE html><html><body style="margin:0;padding:40px 20px;background:#080C10;font-family:sans-serif"><div style="max-width:520px;margin:0 auto;background:#0F1419;border-radius:16px;border:1px solid #1E2D42;overflow:hidden"><div style="background:#0A0F15;padding:20px 24px;border-bottom:1px solid #1E2D42"><span style="font-size:17px;font-weight:700;color:#E2EAF5">🛍️ QuickShop</span></div><div style="padding:24px"><h2 style="margin:0 0 10px;color:#E2EAF5;font-size:16px">${title}</h2><p style="color:#7E97B8;font-size:13px;line-height:1.6;margin:0">${message}</p></div></div></body></html>`, message);
    }
    if (allowed.sms && prefHas(pref, "sms") && c.phone) await sendSms(c.phone, `${title}: ${message}`);
    if (allowed.push && prefHas(pref, "push")) await sendPush(customerId, title, message);
    if (allowed.telegram && prefHas(pref, "telegram") && c.telegram_chat_id) await sendTelegram(c.telegram_chat_id, `🛍️ *${title}*\n\n${message}`);
  } catch (e) { console.error("[notifyCustomer]", e.message); }
}
async function notifyAdmin(type, title, message) {
  try { await supabaseAdmin.from("admin_notifications").insert({ type, title, message }); } catch (e) { console.error("[notifyAdmin]", e.message); }
}

// ── CURRENCY / TIER HELPERS ───────────────────────────────────────
// Best matching tier = highest min_qty <= ordered qty
function matchTier(tiers, qty) {
  const sorted = [...(tiers || [])].sort((a, b) => b.min_qty - a.min_qty);
  return sorted.find(t => qty >= t.min_qty) || sorted[sorted.length - 1] || null;
}

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────
// Customer auth (optional account, Supabase JWT)
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) { req.customerAuth = null; return next(); }
  try {
    const token = authHeader.replace("Bearer ", "");
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data?.user) { req.customerAuth = null; return next(); }
    req.customerAuth = data.user;
    next();
  } catch { req.customerAuth = null; next(); }
}
// Admin auth (shared secret key header, matches reference app's admin pattern)
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── CUSTOMER RESOLUTION ────────────────────────────────────────────
// Finds or creates a customer record by phone/email (guest-first).
// If the request carries a valid Supabase auth token, links/reuses
// the customer row tied to that auth_id.
async function resolveCustomer({ auth_id, name, email, phone }) {
  email = email ? email.toLowerCase().trim() : null;
  phone = phone ? phone.trim() : null;

  if (auth_id) {
    const { data: existing } = await supabaseAdmin.from("customers").select("*").eq("auth_id", auth_id).single();
    if (existing) return existing;
  }
  // Try match by email or phone (guest returning, or linking auth to prior guest orders)
  if (email) {
    const { data: byEmail } = await supabaseAdmin.from("customers").select("*").ilike("email", email).single();
    if (byEmail) {
      if (auth_id && !byEmail.auth_id) await supabaseAdmin.from("customers").update({ auth_id }).eq("id", byEmail.id);
      return { ...byEmail, auth_id: auth_id || byEmail.auth_id };
    }
  }
  if (phone) {
    const { data: byPhone } = await supabaseAdmin.from("customers").select("*").eq("phone", phone).single();
    if (byPhone) {
      if (auth_id && !byPhone.auth_id) await supabaseAdmin.from("customers").update({ auth_id }).eq("id", byPhone.id);
      return { ...byPhone, auth_id: auth_id || byPhone.auth_id };
    }
  }
  const { data: created, error } = await supabaseAdmin.from("customers").insert({ auth_id: auth_id || null, name: name || null, email, phone }).select().single();
  if (error) throw new Error(error.message);
  return created;
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC / CUSTOMER ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/health", (req, res) => res.json({ ok: true, version: "1.0.0" }));

app.get("/api/config", async (req, res) => {
  const s = await getSettings();
  res.json({
    shop_name: s.shop_name || "QuickShop",
    currency_symbol: s.currency_symbol || "₦",
    min_lead_time_hours: parseInt(s.min_lead_time_hours || "2"),
    min_order_value: parseInt(s.min_order_value || "0"),
    delivery_fee: parseInt(s.delivery_fee || "0"),
    paystack_enabled: s.paystack_enabled === "true",
    paystack_public_key: s.paystack_public_key || "",
    push_enabled: s.push_enabled === "true",
    telegram_enabled: s.telegram_enabled === "true",
    telegram_bot_username: s.telegram_bot_username || "",
  });
});

// ── CATEGORIES (public: active only) ─────────────────────────────
app.get("/api/categories", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("categories").select("*").eq("is_active", true).order("sort_order", { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PRODUCTS (public: active only, with tiers + category) ────────
app.get("/api/products", async (req, res) => {
  try {
    const { category_id } = req.query;
    let q = supabaseAdmin.from("products").select("*, product_price_tiers(*)").eq("is_active", true).order("name", { ascending: true });
    if (category_id) q = q.eq("category_id", category_id);
    const { data, error } = await q;
    if (error) throw error;
    const shaped = (data || []).map(p => ({
      ...p,
      product_price_tiers: (p.product_price_tiers || []).sort((a, b) => a.min_qty - b.min_qty)
    }));
    res.json(shaped);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("products").select("*, product_price_tiers(*)").eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ error: "Product not found" });
    data.product_price_tiers = (data.product_price_tiers || []).sort((a, b) => a.min_qty - b.min_qty);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/products/:id/restock-demand", async (req, res) => {
  try {
    const { count } = await supabaseAdmin.from("order_items").select("*", { count: "exact", head: true })
      .eq("product_id", req.params.id).eq("line_status", "pending");
    res.json({ pending_preorders: count || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS — catalog (autonomous) + pre-orders (admin-priced)
// ═══════════════════════════════════════════════════════════════

function scaleTierPrice(tier, qty) {
  if (!tier) return 0;
  const unit = tier.price / tier.min_qty;
  return Math.round(unit * qty);
}

async function checkLowStock(productId) {
  try {
    const { data: p } = await supabaseAdmin.from("products").select("*").eq("id", productId).single();
    if (!p) return;
    if (p.stock_count <= p.low_stock_threshold) {
      await notifyAdmin("low_stock", `⚠️ Low stock: ${p.name}`, `${p.name} has ${p.stock_count} left (threshold: ${p.low_stock_threshold}).`);
    }
  } catch (e) { console.error("[checkLowStock]", e.message); }
}

async function checkRateLimit(customerId) {
  const s = await getSettings();
  const limit = parseInt(s.preorder_rate_limit || "5");
  if (limit <= 0) return;
  const { count } = await supabaseAdmin.from("orders").select("*", { count: "exact", head: true })
    .eq("customer_id", customerId).in("type", ["restock_preorder", "custom_preorder"]).eq("status", "pending");
  if ((count || 0) >= limit) { const e = new Error(`You have too many pending requests (max ${limit}). Please wait for admin review before submitting more.`); e.statusCode = 429; throw e; }
}

// ── PLACE CATALOG ORDER ───────────────────────────────────────────
// Autonomy-first: if all items are in stock at requested qty, the
// order auto-confirms and stock is decremented immediately. If an
// item is short, that line is auto-adjusted (reduced/removed) and
// the response tells the customer what changed — no admin needed.
async function catalogOrderHandler(req, res) {
  try {
    const { name, email, phone, items, payment_method, scheduled_for, notify_preference } = req.body;
    if (!email && !phone) return res.status(400).json({ error: "Email or phone is required" });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "At least one item is required" });

    const s = await getSettings();
    const minLeadHours = parseInt(s.min_lead_time_hours || "2");
    const minOrderValue = parseInt(s.min_order_value || "0");
    const deliveryFee = parseInt(s.delivery_fee || "0");

    if (scheduled_for) {
      const lead = (new Date(scheduled_for) - new Date()) / 3600000;
      if (lead < minLeadHours) return res.status(400).json({ error: `Scheduled orders need at least ${minLeadHours}h lead time.` });
    }

    const customer = await resolveCustomer({ auth_id: req.customerAuth?.id, name, email, phone });
    if (customer.is_blocked) return res.status(403).json({ error: "Your account is currently unable to place orders. Please contact the shop." });
    if (notify_preference) await supabaseAdmin.from("customers").update({ notify_preference }).eq("id", customer.id);

    const adjustedLines = [];
    const finalLines = [];
    let total = 0;

    for (const item of items) {
      const { data: product } = await supabaseAdmin.from("products").select("*, product_price_tiers(*)").eq("id", item.product_id).single();
      if (!product || !product.is_active) { adjustedLines.push({ product_id: item.product_id, reason: "no_longer_available", removed: true }); continue; }

      let qty = Math.max(1, parseInt(item.quantity) || 1);
      if (product.stock_count <= 0) { adjustedLines.push({ product_id: product.id, name: product.name, reason: "out_of_stock", removed: true }); continue; }
      if (qty > product.stock_count) {
        adjustedLines.push({ product_id: product.id, name: product.name, reason: "reduced_qty", requested: qty, available: product.stock_count });
        qty = product.stock_count;
      }
      const tier = matchTier(product.product_price_tiers, qty);
      const lineTotal = tier ? scaleTierPrice(tier, qty) : 0;
      finalLines.push({ product, qty, tier, lineTotal });
      total += lineTotal;
    }

    if (!finalLines.length) return res.status(400).json({ error: "No items could be fulfilled — all were out of stock or unavailable.", adjusted: adjustedLines });

    total += deliveryFee;
    if (minOrderValue > 0 && total < minOrderValue) {
      return res.status(400).json({ error: `Minimum order value is ${s.currency_symbol || "₦"}${minOrderValue}.` });
    }

    const payMethod = payment_method === "pay_online" ? "pay_online" : "pay_on_pickup";
    const { data: order, error: orderErr } = await supabaseAdmin.from("orders").insert({
      customer_id: customer.id, type: "catalog",
      status: payMethod === "pay_online" ? "pending" : "confirmed",
      payment_method: payMethod, payment_status: "unpaid",
      scheduled_for: scheduled_for || null, total_amount: total
    }).select().single();
    if (orderErr) throw orderErr;

    for (const line of finalLines) {
      await supabaseAdmin.from("order_items").insert({
        order_id: order.id, product_id: line.product.id, description: line.product.name,
        quantity: line.qty, admin_price: line.lineTotal, line_status: "accepted"
      });
      if (payMethod === "pay_on_pickup") {
        await supabaseAdmin.from("products").update({ stock_count: line.product.stock_count - line.qty }).eq("id", line.product.id);
        await checkLowStock(line.product.id);
      } else {
        const holdMinutes = parseInt(s.reservation_hold_minutes || "15");
        await supabaseAdmin.from("stock_reservations").insert({
          order_id: order.id, product_id: line.product.id, quantity: line.qty,
          expires_at: new Date(Date.now() + holdMinutes * 60000).toISOString()
        });
        await supabaseAdmin.from("products").update({ stock_count: line.product.stock_count - line.qty }).eq("id", line.product.id);
      }
    }

    const large = parseInt(s.large_order_threshold || "0");
    if (large > 0 && total >= large) await notifyAdmin("large_order", "📦 Large order received", `Order ${order.id.slice(0,8)} — ${s.currency_symbol || "₦"}${total.toLocaleString()}`);

    if (payMethod === "pay_on_pickup") {
      await notifyCustomer(customer.id, "order_confirmed", "Order confirmed! 🎉",
        `Your order of ${finalLines.length} item(s) totaling ${s.currency_symbol || "₦"}${total.toLocaleString()} is confirmed${scheduled_for ? ` for ${new Date(scheduled_for).toLocaleString()}` : ""}.`);
    } else {
      await notifyCustomer(customer.id, "order_placed", "Order received",
        `Your order is awaiting payment confirmation. Total: ${s.currency_symbol || "₦"}${total.toLocaleString()}.`);
    }

    res.status(201).json({ order, adjusted: adjustedLines, total, customer_id: customer.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
app.post("/api/orders/catalog", optionalAuth, catalogOrderHandler);

// ── PRE-ORDERS: restock (tied to existing product) ────────────────
app.post("/api/orders/preorder/restock", optionalAuth, async (req, res) => {
  try {
    const { name, email, phone, product_id, quantity, suggested_price, scheduled_for, notify_preference } = req.body;
    if (!email && !phone) return res.status(400).json({ error: "Email or phone is required" });
    if (!product_id) return res.status(400).json({ error: "product_id is required" });

    const { data: product } = await supabaseAdmin.from("products").select("*, product_price_tiers(*)").eq("id", product_id).single();
    if (!product) return res.status(404).json({ error: "Product not found" });

    const customer = await resolveCustomer({ auth_id: req.customerAuth?.id, name, email, phone });
    if (customer.is_blocked) return res.status(403).json({ error: "Your account is currently unable to place orders." });
    if (notify_preference) await supabaseAdmin.from("customers").update({ notify_preference }).eq("id", customer.id);

    await checkRateLimit(customer.id);

    const qty = Math.max(1, parseInt(quantity) || 1);
    const tier = matchTier(product.product_price_tiers, qty);
    const defaultPrice = tier ? scaleTierPrice(tier, qty) : null;
    const finalSuggested = suggested_price != null ? parseInt(suggested_price) : defaultPrice;

    const { data: order, error } = await supabaseAdmin.from("orders").insert({
      customer_id: customer.id, type: "restock_preorder", status: "pending",
      payment_method: "pay_on_pickup", scheduled_for: scheduled_for || null, total_amount: 0
    }).select().single();
    if (error) throw error;

    await supabaseAdmin.from("order_items").insert({
      order_id: order.id, product_id: product.id, description: product.name,
      quantity: qty, customer_suggested_price: finalSuggested, line_status: "pending"
    });

    await notifyAdmin("new_preorder", `🔔 Restock pre-order: ${product.name}`, `${qty}x requested. Suggested total: ${finalSuggested != null ? finalSuggested : "not specified"}.`);
    await notifyCustomer(customer.id, "order_placed", "Pre-order received",
      `Your request for ${qty}x ${product.name} is pending review. We'll confirm pricing shortly.`);

    res.status(201).json({ order, message: "Pre-order submitted for admin review." });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ── PRE-ORDERS: custom (free-text item, fully manual) ─────────────
app.post("/api/orders/preorder/custom", optionalAuth, async (req, res) => {
  try {
    const { name, email, phone, category_id, description, quantity, suggested_price, scheduled_for, notify_preference } = req.body;
    if (!email && !phone) return res.status(400).json({ error: "Email or phone is required" });
    if (!description || !description.trim()) return res.status(400).json({ error: "Please describe what you'd like to order" });

    const customer = await resolveCustomer({ auth_id: req.customerAuth?.id, name, email, phone });
    if (customer.is_blocked) return res.status(403).json({ error: "Your account is currently unable to place orders." });
    if (notify_preference) await supabaseAdmin.from("customers").update({ notify_preference }).eq("id", customer.id);

    await checkRateLimit(customer.id);

    const qty = Math.max(1, parseInt(quantity) || 1);
    const { data: order, error } = await supabaseAdmin.from("orders").insert({
      customer_id: customer.id, type: "custom_preorder", status: "pending",
      payment_method: "pay_on_pickup", scheduled_for: scheduled_for || null, total_amount: 0,
      admin_note: category_id ? `category_hint:${category_id}` : null
    }).select().single();
    if (error) throw error;

    await supabaseAdmin.from("order_items").insert({
      order_id: order.id, product_id: null, description: description.trim(),
      quantity: qty, customer_suggested_price: suggested_price != null ? parseInt(suggested_price) : null, line_status: "pending"
    });

    await notifyAdmin("new_preorder", "🔔 Custom pre-order request", `"${description.trim().slice(0,80)}" x${qty}`);
    await notifyCustomer(customer.id, "order_placed", "Request received",
      `Your custom request has been submitted for review. We'll be in touch with pricing.`);

    res.status(201).json({ order, message: "Request submitted for admin review." });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// ── CUSTOMER: order history lookup (guest via contact, or via account) ──
app.post("/api/orders/lookup", optionalAuth, async (req, res) => {
  try {
    const { email, phone } = req.body;
    let customer = null;
    if (req.customerAuth?.id) {
      const { data } = await supabaseAdmin.from("customers").select("*").eq("auth_id", req.customerAuth.id).single();
      customer = data;
    }
    if (!customer && email) { const { data } = await supabaseAdmin.from("customers").select("*").ilike("email", email.toLowerCase().trim()).single(); customer = data; }
    if (!customer && phone) { const { data } = await supabaseAdmin.from("customers").select("*").eq("phone", phone.trim()).single(); customer = data; }
    if (!customer) return res.json({ orders: [] });

    const { data: orders, error } = await supabaseAdmin.from("orders").select("*, order_items(*)").eq("customer_id", customer.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ orders, customer_id: customer.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/orders/:id", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("orders").select("*, order_items(*)").eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ error: "Order not found" });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REORDER — re-place a past catalog order as a new one ──────────
app.post("/api/orders/:id/reorder", optionalAuth, async (req, res) => {
  try {
    const { data: original } = await supabaseAdmin.from("orders").select("*, order_items(*)").eq("id", req.params.id).single();
    if (!original) return res.status(404).json({ error: "Original order not found" });
    if (original.type !== "catalog") return res.status(400).json({ error: "Only catalog orders can be reordered directly." });

    const { data: customer } = await supabaseAdmin.from("customers").select("*").eq("id", original.customer_id).single();
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const items = original.order_items.filter(i => i.product_id).map(i => ({ product_id: i.product_id, quantity: i.quantity }));
    if (!items.length) return res.status(400).json({ error: "No reorderable items found." });

    const fakeReq = { body: { email: customer.email, phone: customer.phone, name: customer.name, items, payment_method: req.body.payment_method || original.payment_method }, customerAuth: req.customerAuth };
    return catalogOrderHandler(fakeReq, res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CUSTOMER PROFILE / NOTIFICATION PREFS ─────────────────────────
app.get("/api/customer/notifications", optionalAuth, async (req, res) => {
  try {
    const { customer_id } = req.query;
    let cid = customer_id;
    if (!cid && req.customerAuth?.id) { const { data } = await supabaseAdmin.from("customers").select("id").eq("auth_id", req.customerAuth.id).single(); cid = data?.id; }
    if (!cid) return res.json([]);
    const { data, error } = await supabaseAdmin.from("notifications").select("*").eq("customer_id", cid).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/customer/notifications/:id/read", async (req, res) => {
  try { await supabaseAdmin.from("notifications").update({ is_read: true }).eq("id", req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/customer/:id/preferences", async (req, res) => {
  try {
    const { notify_preference } = req.body;
    const { data, error } = await supabaseAdmin.from("customers").update({ notify_preference }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TELEGRAM LINKING (customer) ────────────────────────────────────
app.post("/api/customer/:id/link-telegram", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Code required" });
    const { data: linkRow } = await supabaseAdmin.from("telegram_link_codes").select("*").eq("code", code).eq("used", false).single();
    if (!linkRow || new Date(linkRow.expires_at) < new Date()) return res.status(400).json({ error: "Invalid or expired code" });
    await supabaseAdmin.from("customers").update({ telegram_chat_id: linkRow.chat_id }).eq("id", req.params.id);
    await supabaseAdmin.from("telegram_link_codes").update({ used: true }).eq("id", linkRow.id);
    res.json({ success: true, chat_id: linkRow.chat_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/customer/:id/unlink-telegram", async (req, res) => {
  try { await supabaseAdmin.from("customers").update({ telegram_chat_id: null }).eq("id", req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEVICE REGISTRATION (push) ─────────────────────────────────────
app.post("/api/customer/:id/device", async (req, res) => {
  try {
    const { subscription_id, device_label } = req.body;
    if (!subscription_id || subscription_id.length < 10) return res.json({ success: false, reason: "invalid_subscription_id" });
    await supabaseAdmin.from("customer_devices").upsert({ customer_id: req.params.id, subscription_id, device_label: device_label || null, last_seen_at: new Date().toISOString() }, { onConflict: "subscription_id" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES — all require x-admin-key header
// ═══════════════════════════════════════════════════════════════

// ── DASHBOARD OVERVIEW ─────────────────────────────────────────────
app.get("/api/admin/overview", requireAdmin, async (req, res) => {
  try {
    const [{ count: totalOrders }, { count: pendingPreorders }, { count: totalProducts }, { count: totalCustomers }] = await Promise.all([
      supabaseAdmin.from("orders").select("*", { count: "exact", head: true }),
      supabaseAdmin.from("orders").select("*", { count: "exact", head: true }).eq("status", "pending").in("type", ["restock_preorder", "custom_preorder"]),
      supabaseAdmin.from("products").select("*", { count: "exact", head: true }).eq("is_active", true),
      supabaseAdmin.from("customers").select("*", { count: "exact", head: true }),
    ]);
    // low stock computed in JS (simpler than a DB-side RPC at this scale)
    const { data: products } = await supabaseAdmin.from("products").select("id,name,stock_count,low_stock_threshold").eq("is_active", true);
    const lowStock = (products || []).filter(p => p.stock_count <= p.low_stock_threshold);
    const { data: revenueRows } = await supabaseAdmin.from("orders").select("total_amount,status").in("status", ["confirmed", "fulfilled"]);
    const revenue = (revenueRows || []).reduce((sum, o) => sum + (o.total_amount || 0), 0);
    res.json({
      total_orders: totalOrders || 0,
      pending_preorders: pendingPreorders || 0,
      total_products: totalProducts || 0,
      low_stock_count: lowStock.length,
      low_stock_products: lowStock.slice(0, 10),
      total_customers: totalCustomers || 0,
      total_revenue: revenue,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/analytics/best-sellers", requireAdmin, async (req, res) => {
  try {
    const { data: items } = await supabaseAdmin.from("order_items").select("product_id, description, quantity").not("product_id", "is", null);
    const map = {};
    (items || []).forEach(i => { map[i.product_id] = map[i.product_id] || { name: i.description, qty: 0 }; map[i.product_id].qty += i.quantity; });
    const sorted = Object.entries(map).map(([id, v]) => ({ product_id: id, name: v.name, total_qty: v.qty })).sort((a, b) => b.total_qty - a.total_qty).slice(0, 10);
    res.json(sorted);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/analytics/revenue-by-category", requireAdmin, async (req, res) => {
  try {
    const { data: items } = await supabaseAdmin.from("order_items").select("admin_price, quantity, product_id, products(category_id, categories(name))");
    const map = {};
    (items || []).forEach(i => {
      const catName = i.products?.categories?.name || "Uncategorized";
      map[catName] = (map[catName] || 0) + (i.admin_price || 0);
    });
    res.json(Object.entries(map).map(([category, revenue]) => ({ category, revenue })).sort((a, b) => b.revenue - a.revenue));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN NOTIFICATIONS FEED ────────────────────────────────────────
app.get("/api/admin/notifications", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("admin_notifications").select("*").order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/admin/notifications/:id/read", requireAdmin, async (req, res) => {
  try { await supabaseAdmin.from("admin_notifications").update({ is_read: true }).eq("id", req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — CATEGORIES
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/categories", requireAdmin, async (req, res) => {
  try { const { data, error } = await supabaseAdmin.from("categories").select("*").order("sort_order", { ascending: true }); if (error) throw error; res.json(data); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/admin/categories", requireAdmin, async (req, res) => {
  try {
    const { name, color, icon, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    const { data, error } = await supabaseAdmin.from("categories").insert({ name, color: color || "#3B82F6", icon: icon || "📦", sort_order: sort_order || 0 }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  try {
    const { name, color, icon, sort_order, is_active } = req.body;
    const { data, error } = await supabaseAdmin.from("categories").update({ name, color, icon, sort_order, is_active }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/admin/categories/:id", requireAdmin, async (req, res) => {
  try { await supabaseAdmin.from("categories").delete().eq("id", req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — PRODUCTS (+ tiers)
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("products").select("*, product_price_tiers(*), categories(name,color,icon)").order("created_at", { ascending: false });
    if (error) throw error;
    const shaped = (data || []).map(p => ({ ...p, product_price_tiers: (p.product_price_tiers || []).sort((a,b) => a.min_qty - b.min_qty) }));
    res.json(shaped);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { name, description, category_id, stock_count, low_stock_threshold, unit_label, tiers } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    const { data: product, error } = await supabaseAdmin.from("products").insert({
      name, description: description || null, category_id: category_id || null,
      stock_count: parseInt(stock_count) || 0, low_stock_threshold: parseInt(low_stock_threshold) || 5,
      unit_label: unit_label || "unit"
    }).select().single();
    if (error) throw error;

    if (Array.isArray(tiers) && tiers.length) {
      const rows = tiers.map(t => ({ product_id: product.id, min_qty: parseInt(t.min_qty), price: parseInt(t.price) }));
      await supabaseAdmin.from("product_price_tiers").insert(rows);
    }
    res.status(201).json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const { name, description, category_id, stock_count, low_stock_threshold, unit_label, is_active, tiers } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (category_id !== undefined) updates.category_id = category_id;
    if (stock_count !== undefined) updates.stock_count = parseInt(stock_count);
    if (low_stock_threshold !== undefined) updates.low_stock_threshold = parseInt(low_stock_threshold);
    if (unit_label !== undefined) updates.unit_label = unit_label;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabaseAdmin.from("products").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;

    if (Array.isArray(tiers)) {
      // Replace all tiers wholesale — simplest consistent model for a small admin form
      await supabaseAdmin.from("product_price_tiers").delete().eq("product_id", req.params.id);
      if (tiers.length) {
        const rows = tiers.map(t => ({ product_id: req.params.id, min_qty: parseInt(t.min_qty), price: parseInt(t.price) }));
        await supabaseAdmin.from("product_price_tiers").insert(rows);
        // Audit log for tier/price edits
        await supabaseAdmin.from("price_audit_log").insert({ product_id: req.params.id, changed_by: "admin", note: `Tiers updated: ${JSON.stringify(tiers)}` });
      }
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try { await supabaseAdmin.from("products").delete().eq("id", req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Quick +/- stock adjust
app.post("/api/admin/products/:id/adjust-stock", requireAdmin, async (req, res) => {
  try {
    const { delta } = req.body;
    const { data: p } = await supabaseAdmin.from("products").select("*").eq("id", req.params.id).single();
    if (!p) return res.status(404).json({ error: "Product not found" });
    const wasOut = p.stock_count <= 0;
    const newStock = Math.max(0, p.stock_count + parseInt(delta));
    const { data, error } = await supabaseAdmin.from("products").update({ stock_count: newStock }).eq("id", req.params.id).select().single();
    if (error) throw error;

    // Restock notification: if it went from 0 (or below threshold) to available,
    // notify everyone with a pending restock pre-order for this product.
    if (wasOut && newStock > 0) await notifyRestockWaiters(req.params.id, p.name);
    if (newStock <= p.low_stock_threshold) await checkLowStock(req.params.id);

    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function notifyRestockWaiters(productId, productName) {
  try {
    const { data: waitingItems } = await supabaseAdmin.from("order_items").select("order_id, quantity, orders(customer_id, status)")
      .eq("product_id", productId).eq("line_status", "pending");
    const notified = new Set();
    for (const item of (waitingItems || [])) {
      const custId = item.orders?.customer_id;
      if (!custId || notified.has(custId)) continue;
      notified.add(custId);
      await notifyCustomer(custId, "restock", `${productName} is back in stock! 🎉`, `Good news — ${productName} is available again. Check the app to complete your order.`);
    }
  } catch (e) { console.error("[notifyRestockWaiters]", e.message); }
}

// Duplicate product
app.post("/api/admin/products/:id/duplicate", requireAdmin, async (req, res) => {
  try {
    const { data: p } = await supabaseAdmin.from("products").select("*, product_price_tiers(*)").eq("id", req.params.id).single();
    if (!p) return res.status(404).json({ error: "Product not found" });
    const { data: copy, error } = await supabaseAdmin.from("products").insert({
      name: `${p.name} (Copy)`, description: p.description, category_id: p.category_id,
      stock_count: 0, low_stock_threshold: p.low_stock_threshold, unit_label: p.unit_label
    }).select().single();
    if (error) throw error;
    if (p.product_price_tiers?.length) {
      const rows = p.product_price_tiers.map(t => ({ product_id: copy.id, min_qty: t.min_qty, price: t.price }));
      await supabaseAdmin.from("product_price_tiers").insert(rows);
    }
    res.status(201).json(copy);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk CSV import — expects rows: name,description,category_name,stock_count,low_stock_threshold,unit_label,tier1_qty,tier1_price,tier2_qty,tier2_price,...
app.post("/api/admin/products/import-csv", requireAdmin, async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv) return res.status(400).json({ error: "csv text is required" });
    const lines = csv.trim().split("\n").map(l => l.trim()).filter(Boolean);
    const header = lines[0].split(",").map(h => h.trim().toLowerCase());
    const rows = lines.slice(1);
    const { data: categories } = await supabaseAdmin.from("categories").select("id,name");
    const catMap = {}; (categories || []).forEach(c => catMap[c.name.toLowerCase()] = c.id);

    let imported = 0, errors = [];
    for (const line of rows) {
      const cols = line.split(",").map(c => c.trim());
      const row = {}; header.forEach((h, i) => row[h] = cols[i]);
      if (!row.name) { errors.push(`Skipped row: missing name`); continue; }
      const category_id = row.category_name ? catMap[row.category_name.toLowerCase()] || null : null;
      const { data: product, error } = await supabaseAdmin.from("products").insert({
        name: row.name, description: row.description || null, category_id,
        stock_count: parseInt(row.stock_count) || 0, low_stock_threshold: parseInt(row.low_stock_threshold) || 5,
        unit_label: row.unit_label || "unit"
      }).select().single();
      if (error) { errors.push(`${row.name}: ${error.message}`); continue; }
      // Parse tier pairs from remaining columns
      const tierPairs = [];
      for (let i = 0; i < 10; i += 2) {
        const qtyKey = `tier${i/2+1}_qty`, priceKey = `tier${i/2+1}_price`;
        if (row[qtyKey] && row[priceKey]) tierPairs.push({ product_id: product.id, min_qty: parseInt(row[qtyKey]), price: parseInt(row[priceKey]) });
      }
      if (tierPairs.length) await supabaseAdmin.from("product_price_tiers").insert(tierPairs);
      imported++;
    }
    res.json({ imported, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — ORDER QUEUE
// ═══════════════════════════════════════════════════════════════
// Tabs: New (confirmed catalog orders awaiting fulfillment) /
//       Scheduled (future-dated) / Pending Pre-Orders / History
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const { tab } = req.query;
    let q = supabaseAdmin.from("orders").select("*, order_items(*), customers(name,email,phone)").order("created_at", { ascending: false });
    if (tab === "new") q = q.eq("status", "confirmed").eq("type", "catalog").is("scheduled_for", null);
    else if (tab === "scheduled") q = q.not("scheduled_for", "is", null).in("status", ["confirmed", "pending"]);
    else if (tab === "pending_preorders") q = q.in("type", ["restock_preorder", "custom_preorder"]).eq("status", "pending");
    else if (tab === "history") q = q.in("status", ["fulfilled", "rejected", "cancelled"]);
    const { data, error } = await q.limit(200);
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("orders").select("*, order_items(*), customers(*)").eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ error: "Order not found" });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark fulfilled (catalog orders, and pre-orders once approved+ready)
app.put("/api/admin/orders/:id/fulfill", requireAdmin, async (req, res) => {
  try {
    const { data: order, error } = await supabaseAdmin.from("orders").update({ status: "fulfilled" }).eq("id", req.params.id).select("*, customers(id)").single();
    if (error) throw error;
    await notifyCustomer(order.customers.id, "order_fulfilled", "Order ready! ✅", "Your order has been fulfilled. Thank you for shopping with us!");
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/orders/:id/cancel", requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const { data: order, error } = await supabaseAdmin.from("orders").update({ status: "cancelled", rejection_reason: reason || null }).eq("id", req.params.id).select("*, order_items(*), customers(id)").single();
    if (error) throw error;
    // Release any reserved/decremented stock back
    for (const item of order.order_items) {
      if (item.product_id) {
        const { data: p } = await supabaseAdmin.from("products").select("stock_count").eq("id", item.product_id).single();
        if (p) await supabaseAdmin.from("products").update({ stock_count: p.stock_count + item.quantity }).eq("id", item.product_id);
      }
    }
    await notifyCustomer(order.customers.id, "order_rejected", "Order cancelled", reason ? `Your order was cancelled: ${reason}` : "Your order was cancelled.");
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── APPROVE/REJECT/PRICE A PRE-ORDER LINE ────────────────────────
// Line-by-line: admin accepts (sets final price) or rejects each item
// individually rather than editing quantities the customer didn't ask for.
app.put("/api/admin/order-items/:id/decide", requireAdmin, async (req, res) => {
  try {
    const { decision, admin_price, note } = req.body; // decision: accepted | rejected
    if (!["accepted", "rejected"].includes(decision)) return res.status(400).json({ error: "decision must be accepted or rejected" });

    const { data: item, error: itemErr } = await supabaseAdmin.from("order_items").select("*, orders(id, customer_id)").eq("id", req.params.id).single();
    if (itemErr || !item) return res.status(404).json({ error: "Order item not found" });

    const updates = { line_status: decision };
    if (decision === "accepted") {
      const finalPrice = admin_price != null ? parseInt(admin_price) : item.customer_suggested_price;
      if (finalPrice == null) return res.status(400).json({ error: "admin_price is required to accept this item" });
      updates.admin_price = finalPrice;
      await supabaseAdmin.from("price_audit_log").insert({ order_item_id: item.id, product_id: item.product_id, changed_by: "admin", old_price: item.customer_suggested_price, new_price: finalPrice, note: note || null });
    }
    const { data: updatedItem, error } = await supabaseAdmin.from("order_items").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;

    // Recompute order status/total once all lines in the order are decided
    const { data: allItems } = await supabaseAdmin.from("order_items").select("*").eq("order_id", item.orders.id);
    const stillPending = allItems.some(i => i.line_status === "pending");
    const anyAccepted = allItems.some(i => i.line_status === "accepted");
    const computedTotal = allItems.filter(i => i.line_status === "accepted").reduce((sum, i) => sum + (i.admin_price || 0), 0);

    if (!stillPending) {
      const newStatus = anyAccepted ? "confirmed" : "rejected";
      await supabaseAdmin.from("orders").update({ status: newStatus, total_amount: computedTotal }).eq("id", item.orders.id);
      if (newStatus === "confirmed") {
        await notifyCustomer(item.orders.customer_id, "order_priced", "Your order is priced! 💰", `Your pre-order has been reviewed. Total: ${computedTotal}. It's now confirmed.`);
      } else {
        await notifyCustomer(item.orders.customer_id, "order_rejected", "Pre-order not available", "Unfortunately we couldn't fulfill your custom request this time.");
      }
    } else if (decision === "accepted") {
      await notifyCustomer(item.orders.customer_id, "order_priced", "Item priced", `"${item.description}" has been priced at ${updatedItem.admin_price}. Awaiting review of remaining items.`);
    }

    res.json(updatedItem);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — CUSTOMERS
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try { const { data, error } = await supabaseAdmin.from("customers").select("*").order("created_at", { ascending: false }); if (error) throw error; res.json(data); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/admin/customers/:id/block", requireAdmin, async (req, res) => {
  try { const { blocked } = req.body; const { data, error } = await supabaseAdmin.from("customers").update({ is_blocked: !!blocked }).eq("id", req.params.id).select().single(); if (error) throw error; res.json(data); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — SETTINGS
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try { res.json(await getSettings()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) await setSetting(key, String(value));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Broadcast a manual notification to a customer or all customers
app.post("/api/admin/broadcast/notification", requireAdmin, async (req, res) => {
  try {
    const { send_all, customer_id, type, title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: "Title and message are required" });
    if (send_all) {
      const { data: customers } = await supabaseAdmin.from("customers").select("id");
      for (const c of (customers || [])) await notifyCustomer(c.id, type || "system", title, message);
      return res.json({ sent: (customers || []).length });
    }
    if (!customer_id) return res.status(400).json({ error: "customer_id required when send_all is false" });
    await notifyCustomer(customer_id, type || "system", title, message);
    res.json({ sent: 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/price-audit-log", requireAdmin, async (req, res) => {
  try { const { data, error } = await supabaseAdmin.from("price_audit_log").select("*").order("created_at", { ascending: false }).limit(100); if (error) throw error; res.json(data); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════

// Release expired stock reservations (unpaid pay_online holds)
async function releaseExpiredReservations() {
  try {
    const { data: expired } = await supabaseAdmin.from("stock_reservations").select("*").eq("released", false).lt("expires_at", new Date().toISOString());
    for (const r of (expired || [])) {
      const { data: p } = await supabaseAdmin.from("products").select("stock_count").eq("id", r.product_id).single();
      if (p) await supabaseAdmin.from("products").update({ stock_count: p.stock_count + r.quantity }).eq("id", r.product_id);
      await supabaseAdmin.from("stock_reservations").update({ released: true }).eq("id", r.id);
      // Also mark the order cancelled if it never got paid
      const { data: order } = await supabaseAdmin.from("orders").select("*").eq("id", r.order_id).single();
      if (order && order.payment_status === "unpaid" && order.status === "pending") {
        await supabaseAdmin.from("orders").update({ status: "cancelled", rejection_reason: "Payment window expired" }).eq("id", r.order_id);
      }
    }
    if ((expired || []).length) console.log(`[reservations] Released ${expired.length} expired hold(s).`);
  } catch (e) { console.error("[releaseExpiredReservations]", e.message); }
}

// Scheduled order reminders — notify customer X hours before scheduled_for
async function sendScheduledReminders() {
  try {
    const s = await getSettings();
    const hoursBefore = parseInt(s.reminder_hours_before || "3");
    const now = new Date();
    const windowStart = new Date(now.getTime() + (hoursBefore - 0.25) * 3600000);
    const windowEnd = new Date(now.getTime() + (hoursBefore + 0.25) * 3600000);
    const { data: orders } = await supabaseAdmin.from("orders").select("*, customers(id)")
      .eq("status", "confirmed").not("scheduled_for", "is", null)
      .gte("scheduled_for", windowStart.toISOString()).lte("scheduled_for", windowEnd.toISOString());
    for (const o of (orders || [])) {
      await notifyCustomer(o.customers.id, "reminder", "Order reminder ⏰", `Your scheduled order is coming up at ${new Date(o.scheduled_for).toLocaleString()}.`);
    }
    if ((orders || []).length) console.log(`[reminders] Sent ${orders.length} scheduled order reminder(s).`);
  } catch (e) { console.error("[sendScheduledReminders]", e.message); }
}

async function scheduleCrons() {
  Object.values(cronJobs).forEach(j => { try { j.stop(); } catch {} });
  cronJobs = {};
  cronJobs.releaseReservations = cron.schedule("*/2 * * * *", releaseExpiredReservations);
  cronJobs.scheduledReminders = cron.schedule("*/15 * * * *", sendScheduledReminders);

  // Render keep-alive: ping own /health every 14 minutes
  cronJobs.render_keepalive = cron.schedule("*/14 * * * *", async () => {
    const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 4000}`;
    try { await axios.get(selfUrl + "/health", { timeout: 8000 }); } catch (err) { console.error("Render keep-alive error:", err.message); }
  });
  console.log("Crons scheduled: reservation release (2min), scheduled reminders (15min), keep-alive (14min).");
}

// Daily cleanup: expired telegram link codes
cron.schedule("0 3 * * *", async () => {
  try { await supabaseAdmin.from("telegram_link_codes").delete().lt("expires_at", new Date().toISOString()); }
  catch (e) { console.error("[Telegram cleanup]", e.message); }
});

const PORT = parseInt(process.env.PORT) || 4000;
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`QuickShop API v1.0.0 on port ${PORT}`);
  await scheduleCrons();
  initTelegramBot();
});



