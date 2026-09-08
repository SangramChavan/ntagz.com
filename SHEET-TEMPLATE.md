# Google Sheet → ntagz (price sync + order ledger)

This repo keeps **`js/catalog.js` as the single source of truth** for products. The
sheet is an editing layer **and** a live order ledger:

- the GitHub Action `sync-sheet` reads two published tabs, patches the numbers into
  `catalog.js`, bumps the cache-buster, and commits back — prices on the site and on
  `pricing.html` follow automatically;
- an **`orders` tab** captures every "Confirm Order via WhatsApp" click straight from
  `order.html` (via a one-time Apps Script web-app deployment).

> Everything else (names, skus, descriptions, images, MOQ, unit labels) stays in
> `catalog.js` — the sheet only edits **prices** and **tier percents**, so it can't
> break the catalogue structure. Order rows are append-only; the sheet never writes
> back into the site.

---

## 1. Create the sheet (2 min)

[Click here](https://sheets.new) → name it `ntagz-catalog` → add two tabs:

### Tab `products` — one row per catalogue product

| Header | Meaning |
|---|---|
| `id` | must exactly match the `id:` in `js/catalog.js` (e.g. `black-nfc-card`) |
| `price` | unit price in ₹ (decimal allowed, e.g. `32.80`) |

### Tab `tiers` — the bulk tiers (optional tab; delete if you never change tiers)

| Header | Meaning |
|---|---|
| `min` | tier start qty |
| `max` | tier end qty (write `Infinity` for "max = no upper bound") |
| `percent` | discount percent at this tier |
| `label` | shown to buyers, e.g. `500+ · 10% OFF` |

**Example tiers row:** `1000,9999,15,1000+ · 15% OFF` → a 15% tier from
1,000 to 9,999 pcs. Set `label` to "Custom" when it's a call-for-quote tier.

---

## 2. Publish both tabs

File → **Share → Publish to web**:

1. **Tab** dropdown → `products` → ✅ **CSV** → **Publish** → copy the URL
2. Repeat for `tiers` (if used)

> ⚠️ Published CSV always serves the *first* tab. If your sheet's first tab isn't
> `products`, reorder tabs so `products` is first, or use
> `sheet_id/gviz/tq?tqx=out:csv&sheet=products` to target a specific tab —
> `scripts/sync-from-sheet.js` only parses one CSV per URL.

---

## 3. Wire it to the repo

In GitHub, repo **Settings → Actions → Variables → New repository variable**:

| Variable | Value |
|---|---|
| `PRODUCTS_CSV_URL` | your published `products` CSV URL |
| `TIERS_CSV_URL` | your published `tiers` CSV URL (skip if unused) |

The Action runs **daily at 08:30 IST** and on **manual dispatch**
(Actions → Sync catalog from Google Sheet → Run workflow). Anytime you change the
sheet, just hit "Run workflow" and the site follows in minutes.

---

## 4. Order ledger (log every WhatsApp order confirmation)

No manual tab needed — the script creates the **`orders`** tab + header on the first
order. One-time wiring:

1. **In the spreadsheet:** Extensions → Apps Script → paste the contents of
   `scripts/order-log-appscript.gs` → save.
2. **Deploy → New deployment → "Web app"**: Execute as *Me*, access *Anyone* → copy
   the `…/exec` URL.
3. **In the repo `order.html`**, paste it next to the order-log comment:
   `window.NTAGZ_ORDER_LOG_ENDPOINT = "<your /exec URL>";`
4. (Optional) set `ALLOW_KEY` in the script to a random string + the same value as
   `window.NTAGZ_ORDER_LOG_KEY` in `order.html` to filter casual spam. It's visible
   in page source — it reduces noise, it is not real security.

**What happens:** the moment a customer clicks *Confirm Order via WhatsApp*, a row is
appended with timestamp, quote ref, customer details, item lines, and the full
amount breakdown — matching the WhatsApp message exactly. The write is
fire-and-forget: even if it fails, WhatsApp opens normally and a minimal
`{ref, ts, total}` fallback is kept in the customer's browser localStorage.

**`orders` tab columns** (auto-created):

| Column | Content |
|---|---|
| Timestamp | ISO time of the click |
| Ref | quotation reference from the order page |
| Name / Phone / Address / Pincode / State / GSTIN | customer details from the form |
| Items | `SKU x QTY (-disc%) = net` lines joined with `\|` |
| Qty / Subtotal / Discount / Net / Shipping / GST Amt / Grand Total | order maths |
| Status | `NEW` (mark as `CONFIRMED` / `DISPATCHED` / `CANCELLED` in the sheet) |
| Source | `order.html` |

---

## Test locally (optional)

```bash
PRODUCTS_CSV_URL=https://docs.google.com/spreadsheets/.../pub?output=csv \
TIERS_CSV_URL=... \
node scripts/sync-from-sheet.js
```

It exits `0` on success/no-change, `1` on a bad price/id — it will **never** commit
a broken catalogue; it just fails loudly instead.