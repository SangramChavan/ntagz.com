#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   ntagz — SYNC CATALOG FROM A PUBLISHED GOOGLE SHEET (no deps)
   ───────────────────────────────────────────────────────────────────
   Reads two optional published-CSV URLs (env) and patches
   js/catalog.js so the site keeps ONE source of truth:

     PRODUCTS_CSV_URL  →  per-product unit `price` (matched by `id`)
     TIERS_CSV_URL     →  replaces the DISCOUNT_TIERS array

   After patching it bumps the `?v=YYYYMMDD` cache-buster on the
   catalog.js <script> tags in index.html, order.html and
   pricing.html (the documented 4h edge-cache convention).

   It never edits names, skus, images or descriptions — those stay in
   catalog.js. Exit code 1 on any validation failure (fail cheaply),
   and it does NOTHING if the numbers are unchanged.

   Sheet column requirements (first row = header, exact names):
     PRODUCTS tab:  id, price
     TIERS tab:     min, max, percent, label
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'js', 'catalog.js');
const PAGES = ['index.html', 'order.html', 'pricing.html']
  .map((p) => path.join(ROOT, p));

const PRODUCTS_URL = process.env.PRODUCTS_CSV_URL || '';
const TIERS_URL = process.env.TIERS_CSV_URL || '';

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

async function getCsv(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return parseCsv(await res.text());
}

function patchProducts(src, rows) {
  if (!rows.length) return src;
  let changed = [];
  rows.forEach((r) => {
    if (!r.id || r.price === '') return;
    const price = Number(r.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`invalid price for product '${r.id}': '${r.price}'`);
    }
    const re = new RegExp(`(\\bid:\\s*'${r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[\\s\\S]*?\\bprice:\\s*)(\\d+(?:\\.\\d+)?)`);
    const m = src.match(re);
    if (!m) throw new Error(`product id '${r.id}' not found in catalog.js`);
    if (m[2] !== String(price)) {
      src = src.replace(re, (_, pre) => pre + price);
      changed.push(`${r.id}: ${m[2]} → ${price}`);
    }
  });
  return { src, changed };
}

function patchTiers(src, rows) {
  if (!rows.length) return { src, changed: [], tiers: null };
  const tiers = rows.map((r) => {
    const min = Number(r.min);
    const percent = Number(r.percent);
    const isOpenEnd = r.max === 'Infinity' || r.max === '';
    const max = isOpenEnd ? Infinity : Number(r.max);
    if (!Number.isFinite(min) || !Number.isFinite(percent) ||
        (!isOpenEnd && !Number.isFinite(max))) {
      throw new Error(`invalid tier row: ${JSON.stringify(r)}`);
    }
    const label = r.label || percent + '% OFF';
    const maxLit = max === Infinity ? 'Infinity' : max;
    const custom = label.toLowerCase().includes('custom') ? ', custom: true' : '';
    return `    { min: ${min}, max: ${maxLit}, percent: ${percent}, label: '${String(label).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'${custom} }`;
  });
  const blockRe = /(\/\* ── Bulk discount tiers[\s\S]*?var DISCOUNT_TIERS = \[)[\s\S]*?(\];)/;
  if (!blockRe.test(src)) throw new Error('DISCOUNT_TIERS block not found');
  const old = blockRe.exec(src)[0];
  const next = blockRe.exec(src)[1] + '\n' + tiers.join(',\n') + '\n  ];';
  return { src: src.replace(old, next), changed: old === next ? [] : ['DISCOUNT_TIERS updated'], tiers };
}

function bumpPages(pages) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let changed = 0;
  pages.forEach((p) => {
    const cur = fs.readFileSync(p, 'utf8');
    const next = cur.replace(/(catalog\.js\?v=)\d{8}/g, (_m, pre) => pre + stamp);
    if (next !== cur) { fs.writeFileSync(p, next); changed++; }
  });
  return changed;
}

async function main() {
  if (!PRODUCTS_URL && !TIERS_URL) {
    console.log('No PRODUCTS_CSV_URL or TIERS_CSV_URL set — nothing to do.');
    console.log(`Tip: add both as repo "Actions variables" in Settings, or run with -e PRODUCTS_CSV_URL=...`);
    process.exit(0);
  }

  let src = fs.readFileSync(CATALOG, 'utf8');
  const delta = [];

  if (PRODUCTS_URL) {
    const rows = await getCsv(PRODUCTS_URL);
    const r = patchProducts(src, rows);
    src = r.src; delta.push(...r.changed);
  }
  if (TIERS_URL) {
    const rows = await getCsv(TIERS_URL);
    const r = patchTiers(src, rows);
    src = r.src; delta.push(...r.changed);
  }

  if (!delta.length) {
    console.log('No price/tier changes detected — catalog.js is already current.');
    process.exit(0);
  }

  fs.writeFileSync(CATALOG, src);
  const bumped = bumpPages(PAGES);

  console.log('Updated js/catalog.js:');
  delta.forEach((d) => console.log('  • ' + d));
  console.log(`Cache-busters "${'?v=' + new Date().toISOString().slice(0, 10).replace(/-/g, '')}" bumped on ${bumped} page(s).`);
  process.exit(0);
}

main().catch((err) => { console.error('sync-from-sheet failed: ' + err.message); process.exit(1); });