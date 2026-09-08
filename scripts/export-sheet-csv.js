#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   ntagz — EXPORT GOOGLE-SHEET BOOTSTRAP CSVs from catalog.js
   ───────────────────────────────────────────────────────────────
   Generates assets/sheets/products.csv and assets/sheets/tiers.csv
   — the exact headers/filenames the sync script + Google Sheet
   expect — straight from the live catalogue, so the sheet can never
   start from drifted numbers.

   Import them with the spreadsheet via File → Import → Upload →
   "Replace current sheet":
     products.csv → range A1:A2... (tab "products", header id,price)
     tiers.csv    → tab "tiers"    (header min,max,percent,label)

   Re-run (`node scripts/export-sheet-csv.js`) any time you want a
   fresh copy to re-import or to compare against the notebook.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const CATALOG = path.join(__dirname, '..', 'js', 'catalog.js');
const OUT = path.join(__dirname, '..', 'assets', 'sheets');

const src = fs.readFileSync(CATALOG, 'utf8');

/* Capture the products + DISCOUNT_TIERS arrays by running catalog.js in
   a VM sandbox (it's ours, ships on every page, and ends with
   NTAGZ_CATALOG on `window`). */
function capture() {
  const vm = require('vm');
  const sandbox = { window: {}, console: console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.NTAGZ_CATALOG;
}

try {
  const { products, tiers } = capture();

  const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';
  const q = (s) => String(s).replace(/,/g, ','); // ids/labels have no commas by design

  const productRows = [['id', 'price']].concat(products.map((p) => [q(p.id), p.price]));
  const tierRows = [['min', 'max', 'percent', 'label']].concat(
    tiers.map((t) => [t.min, t.max === Infinity ? 'Infinity' : t.max, t.percent, q(t.label)])
  );

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'products.csv'), csv(productRows));
  fs.writeFileSync(path.join(OUT, 'tiers.csv'), csv(tierRows));

  console.log('products.csv →', productRows.length - 1, 'rows');
  console.log('tiers.csv    →', tierRows.length - 1, 'rows');
  console.log('→', OUT);
} catch (e) {
  console.error('export failed:', e.message);
  process.exit(1);
}