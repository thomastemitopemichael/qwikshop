# QuickShop

Category-based shop app: bulk/tiered pricing, autonomous catalog ordering,
restock & custom pre-orders with admin pricing, scheduled orders, guest-first
checkout, and multi-channel notifications (email/SMS/push/Telegram).

## Structure

```
backend/    Express API + Supabase schema
frontend/   Customer-facing app (WebView-embedded — no browser chrome assumed)
admin/      Admin panel (normal browser page for shop staff)
```

## 1. Database setup

1. Create a Supabase project.
2. Open SQL Editor → paste all of `backend/schema.sql` → Run. Safe to re-run.

## 2. Backend setup

```
cd backend
npm install
cp .env.example .env   # fill in your values
npm start
```

Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`,
`ADMIN_KEY` (a long random string — this is the admin panel's login secret).
Everything else (email/SMS/push/Telegram/Paystack) is optional; features
degrade gracefully if unconfigured (e.g. no SMS sends if AT keys are missing,
but the order still succeeds and other channels still fire).

## 3. Frontend (customer app) — IMPORTANT: this is WebView-embedded

`frontend/index.html` + `frontend/app.js` are built to run **inside a native
app's WebView**, not as a standalone public website. Two things you need to
do before it'll run:

**a) Drop in `lucide.min.js`** — place a copy of the Lucide icon library file
   named `lucide.min.js` in the same directory as `index.html`. The app
   references it via a plain relative `<script src="lucide.min.js">` tag
   (no CDN dependency, matching the offline-friendly WebView pattern).

**b) Inject the API base URL from the native shell** — there's no address bar
   in a WebView for a user to configure a backend URL, so the app reads it
   from a global your native app sets *before* `app.js` runs:
   ```js
   window.QUICKSHOP_API_BASE = "https://your-api.example.com/api";
   ```
   Set this via your WebView's preload script / JS-injection bridge
   (e.g. `evaluateJavascript` on Android, `WKUserScript` on iOS, or your
   cross-platform framework's equivalent). Without it, the app falls back to
   `http://localhost:4000/api` for local testing only.

## 4. Admin panel

`admin/admin.html` + `admin/admin.js` are a normal browser page (for shop
staff, not embedded in the customer app), so it's fine to open directly.
Same `lucide.min.js` file-drop requirement applies here too.

On first load it'll ask for the **Admin Key** — this is the `ADMIN_KEY` value
you set in the backend `.env`. It's stored in `sessionStorage` only (cleared
when the browser tab closes), and it also persists its own API base URL in
`localStorage` since staff may need to point it at different environments.

## Key design decisions (recap)

- **Catalog orders auto-confirm** if stock covers the request — no admin
  approval needed. Out-of-stock items are auto-adjusted/removed with the
  customer notified, rather than blocking the whole order.
- **Out-of-stock products redirect to "pre-order this instead"**, pre-filling
  the restock pre-order form with the catalog price as a starting offer.
- **Pre-orders (restock + custom)** are the only things needing admin
  attention, decided **line-by-line** (accept-with-price or reject) rather
  than admin rewriting quantities the customer didn't ask for.
- **No product images** — categories/products use emoji icons instead, to
  keep database usage low.
- Loyalty points, referrals, recurring orders, multi-admin roles, and
  supplier cost tracking were intentionally deferred to a later phase.
