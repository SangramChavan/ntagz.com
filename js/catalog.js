/* ═══════════════════════════════════════════════════════════════
   ntagz — SHARED PRODUCT CATALOGUE (single source of truth)
   ───────────────────────────────────────────────────────────────
   Loaded by BOTH index.html (homepage grid) and order.html (quote
   builder). Add a product here once and it shows up in both places.

   ── HOW TO ADD A PRODUCT ──
   1. Copy any block in `products` below and change the fields.
   2. `id`      — unique slug, also used in the order deep-link
                  (order.html?add=<id>)
   3. `image`   — path to a photo in images/. Leave null and a clean
                  placeholder tile is drawn instead.
   4. `home`    — true  → a card is rendered on the homepage grid
                  false → order page only
      Set `homeStatic: true` if you have ALSO hand-written a card for
      it in index.html; the injector then leaves the homepage alone
      (hand-written cards win, so SEO copy is never overwritten).
   5. `detail`  — product page URL, or null if there isn't one yet.

   Prices are ex-GST, in INR. Keep them in sync with the matching
   product/<slug>/index.html schema block.

   Exception: products flagged  allInclusive: true  are priced as a
   final, all-inclusive amount (GST + shipping absorbed), e.g. the
   Google Review NFC Stands at ₹499/pc. The quote builder (order.js)
   does not add GST or shipping on top of those products.

   ── AFTER EDITING THIS FILE ──
   This file is cached 4h at the edge with no other cache-busting.
   Bump the ?v=YYYYMMDD query string on its <script> tag in BOTH
   index.html and order.html, or returning visitors keep seeing the
   old catalogue for up to 4 hours after you deploy.
   ═══════════════════════════════════════════════════════════════ */

(function (root) {
  'use strict';

  /* ── Bulk discount tiers (per line item, by quantity) ──
     These drive BOTH the tier table rendered on order.html and the
     maths in the quote. Edit here only.                            */
  var DISCOUNT_TIERS = [
    { min: 10, max: 499, percent: 0, label: 'MOQ · No discount' },
    { min: 500, max: 999, percent: 10, label: '10% OFF' },
    { min: 1000, max: 4999, percent: 15, label: '15% OFF' },
    { min: 5000, max: 9999, percent: 25, label: '25% OFF' },
    { min: 10000, max: Infinity, percent: 25, label: 'Custom Rate', custom: true }
  ];

  var SHIPPING = {
    freeAbove: 2000,        // net taxable value, INR
    homeState: 'Maharashtra',
    homeStateRate: 40,
    restOfIndiaRate: 80
  };

  var products = [

    /* ── SAMPLE KIT ─────────────────────────────────────────── */
    {
      id: 'sample-kit',
      sku: 'SMPL',
      name: 'Complete NFC Sample Kit',
      price: 1940,
      unit: 'kit',
      image: 'images/black-nfc-card.png',
      detail: 'product/sample-kit/',
      category: 'nfc',          // order page tab: 'nfc' | 'rfid'
      homeCategory: 'sample',   // homepage filter: nfc | tag | rfid | sample
      tags: ['All 7 Types', '10 pcs each', '70 pcs total'],
      desc: 'Ten pieces of every product in one box — black card, white card, anti-metal tag, adhesive tag, coin, mini tag and micro flex. Test before committing to a bulk run.',
      fixed: true,
      fixedQty: 70,
      fixedLabel: '1 kit · 70 pcs · all 7 variants',
      badge: 'Bundle',
      home: true,
      homeStatic: true
    },

    /* ── NFC CARDS ──────────────────────────────────────────── */
    {
      id: 'black-nfc-card',
      sku: 'BNC30',
      name: 'Black NFC 215 Card',
      price: 30,
      unit: 'card',
      image: 'images/black-nfc-card.png',
      detail: 'product/black-nfc-card/',
      category: 'nfc',
      homeCategory: 'nfc',
      tags: ['NFC', 'CR80', 'Black PVC'],
      desc: 'Premium blank black PVC card with an NTAG215 chip. Built for UV printing and high-end digital business cards.',
      badge: 'Bestseller',
      home: true,
      homeStatic: true
    },
    {
      id: 'white-nfc-card',
      sku: 'WNC25',
      name: 'PVC NFC Business Card NTAG216',
      price: 25,
      unit: 'card',
      image: 'images/white-nfc-card.jpeg',
      detail: 'product/white-nfc-card/',
      category: 'nfc',
      homeCategory: 'nfc',
      tags: ['NFC', 'CR80', 'White PVC'],
      desc: 'Blank white PVC card with the high-capacity NTAG216 chip. Ideal for corporate ID and full-colour sublimation printing.',
      home: true,
      homeStatic: true
    },
    {
      id: 'white-inkjet-nfc-card',
      sku: 'WBC33',
      name: 'White Inkjet NTAG215 Card',
      price: 32.80,
      unit: 'card',
      image: 'images/white-nfc-card.jpeg',
      detail: 'product/white-inkjet-nfc-card/',
      category: 'nfc',
      homeCategory: 'nfc',
      tags: ['NFC', 'NTAG215', 'Inkjet Printable'],
      desc: 'Inkjet-printable white PVC card with NTAG215, compatible with Epson L8050 and other PVC-tray card printers.',
      home: true,
      homeStatic: true
    },
    {
      id: 'google-review-nfc-card',
      sku: 'GRV95',
      name: 'Google Review NFC Card',
      price: 95,
      unit: 'card',
      image: 'images/google-review-card.jpg',
      detail: 'product/google-review-nfc-card/',
      category: 'nfc',
      homeCategory: 'nfc',
      tags: ['NFC', 'Printed', 'Review Collection'],
      desc: 'Printed and pre-programmed review card — one tap opens your Google review form. Supplied ready to place on a counter.',
      badge: 'Printed & Programmed',
      home: true
    },

    /* ── GOOGLE REVIEW NFC STAND (tabletop, one product, two SKUs)
       The QR fallback is size-locked, not a free choice: the 10×10
       is NFC-only (smaller panel, no room for a QR block) and the
       12×12 is NFC + a printed QR fallback. Two SKUs, one page.
       home:false — order page only, no homepage tile. */
    {
      id: 'google-review-nfc-stand-10x10',
      sku: 'GRS150',
      name: 'Google Review NFC Stand — 10×10 cm (NFC only)',
      price: 499,
      unit: 'pc',
      moq: 1,
      allInclusive: true,
      image: 'images/google-review-stand-10x10.jpg',
      detail: 'product/google-review-nfc-stand/',
      category: 'nfc',
      homeCategory: 'nfc',
      tags: ['NFC', 'Tabletop Stand', '10×10 cm'],
      desc: 'Tap-to-review counter stand, 10×10 cm, NFC only. Pre-programmed with your Google review link before dispatch.',
      home: false
    },
    {
      id: 'google-review-nfc-stand-12x12',
      sku: 'GRQ200',
      name: 'Google Review NFC + QR Stand — 12×12 cm',
      price: 499,
      unit: 'pc',
      moq: 1,
      allInclusive: true,
      image: 'images/google-review-stand-12x12.jpg',
      detail: 'product/google-review-nfc-stand/',
      category: 'nfc',
      homeCategory: 'nfc',
      tags: ['NFC', 'QR Fallback', '12×12 cm'],
      desc: 'Tap-to-review counter stand, 12×12 cm, NFC plus a printed QR fallback for phones without NFC. Pre-programmed before dispatch.',
      home: false
    },

    {
      id: 'nfc-card-custom-printing',
      sku: 'PRN75',
      name: 'NFC Card with Custom Printing',
      price: 75,
      unit: 'card',
      image: null,
      detail: null,
      category: 'nfc',
      homeCategory: 'nfc',
      tags: ['NFC', 'Full Colour', 'Printed In-House'],
      desc: 'Send us your artwork and we print, encode and dispatch finished NFC cards. Price includes printing and programming.',
      home: true
    },

    /* ── NFC TAGS ───────────────────────────────────────────── */
    {
      id: 'anti-metal-tag',
      sku: 'MNT20',
      name: 'Anti-Metal NFC Tag',
      price: 20,
      unit: 'pc',
      image: 'images/anti-metal-tag.jpg',
      detail: 'product/anti-metal-tag/',
      category: 'nfc',
      homeCategory: 'tag',
      tags: ['NFC', 'Anti-Metal', 'Adhesive'],
      desc: 'Ferrite-isolated tag that keeps working on metal — machinery, laptops, tool cribs and phone backs.',
      home: true,
      homeStatic: true
    },
    {
      id: 'ntag216-adhesive-tag',
      sku: 'RNT18',
      name: 'NTAG216 Adhesive NFC Tag',
      price: 18,
      unit: 'pc',
      image: 'images/nfc-adhesive-tag.jpg',
      detail: 'product/ntag216-adhesive-tag/',
      category: 'nfc',
      homeCategory: 'tag',
      tags: ['NFC', 'NTAG216', 'Asset Tracking'],
      desc: 'High-capacity 888-byte adhesive tag for asset tagging, equipment logs and commercial tracking workflows.',
      home: true,
      homeStatic: true
    },
    {
      id: 'nfc-coin',
      sku: 'NCN20',
      name: 'NTAG 215 Coin 25mm',
      price: 20,
      unit: 'pc',
      image: 'images/nfc-coin.jpeg',
      detail: 'product/nfc-coin/',
      category: 'nfc',
      homeCategory: 'tag',
      tags: ['NFC', '25mm', 'NTAG215'],
      desc: 'Durable 25mm coin-format tag for inventory, outdoor tracking and embedding into physical objects.',
      home: true,
      homeStatic: true
    },
    {
      id: 'mini-nfc-tag',
      sku: 'MNT16',
      name: 'Mini NFC Tag (3D Printing / Jewellery)',
      price: 16,
      unit: 'pc',
      image: 'images/mini-nfc-tag.jpeg',
      detail: 'product/mini-nfc-tag/',
      category: 'nfc',
      homeCategory: 'tag',
      tags: ['NFC', 'Mini', 'Embeddable'],
      desc: 'Ultra-compact tag for embedding into 3D prints, custom jewellery, smart rings and discreet packaging.',
      home: true,
      homeStatic: true
    },
    {
      id: 'micro-flex-fpc',
      sku: 'FNT75',
      name: 'Micro Flex NFC Tag (FPC)',
      price: 75,
      unit: 'unit',
      image: 'images/micro-flex-fpc.jpeg',
      detail: 'product/micro-flex-fpc/',
      category: 'nfc',
      homeCategory: 'tag',
      tags: ['Flex FPC', 'Multi-Size', 'Micro NFC'],
      desc: 'Flexible polyimide micro-tag for very tight spaces. 5x5mm, 4x10mm, 6x15mm, 8mm and 10mm variants.',
      home: true,
      homeStatic: true
    },
    {
      id: 'nfc-wristband',
      sku: 'WRB80',
      name: 'NFC Wristband',
      price: 80,
      unit: 'pc',
      image: null,
      detail: null,
      category: 'nfc',
      homeCategory: 'tag',
      tags: ['NFC', 'Silicone', 'Events & Access'],
      desc: 'Reusable silicone wristband with an embedded NFC inlay — event check-in, cashless stalls and gym access.',
      home: true
    },

    /* ── RFID ───────────────────────────────────────────────── */
    {
      id: 'uhf-rfid-label',
      sku: 'URL249',
      name: 'UHF RFID Label Sticker 27×15mm',
      price: 249,
      unit: 'pack',
      unitLabel: 'pack of 10',
      packSize: 10,
      moq: 1,
      step: 1,
      image: 'images/UHF-RFID-Label-Sticker-27x15mm.jpg',
      detail: 'product/uhf-rfid-label/',
      category: 'rfid',
      homeCategory: 'rfid',
      tags: ['UHF RFID', 'EPC Gen2', 'KU7 Chip', '860–960MHz'],
      desc: 'Self-adhesive UHF label, EPC Gen2, 860–960MHz, roughly 2m read range. Reader-based only — phones cannot read it. Sold on a roll in packs of 10.',
      badge: 'New',
      home: true,
      homeStatic: true
    },
    {
      id: 'rfid-card-custom-printing',
      sku: 'RFP75',
      name: 'RFID Card with Custom Printing',
      price: 75,
      unit: 'card',
      image: null,
      detail: null,
      category: 'rfid',
      homeCategory: 'rfid',
      tags: ['RFID', 'Full Colour', 'Printed In-House'],
      desc: 'RFID access or membership card printed with your artwork and encoded in-house before dispatch.',
      home: true
    }
  ];

  /* ── Helpers shared by both pages ───────────────────────── */

  function byId(id) {
    for (var i = 0; i < products.length; i++) {
      if (products[i].id === id) return products[i];
    }
    return null;
  }

  /* Minimum order quantity for a product (default 10 pcs). */
  function moqFor(p) {
    if (p.fixed) return 1;
    return typeof p.moq === 'number' ? p.moq : 10;
  }

  /* Singular / plural unit word, e.g. "pc" → "pcs". */
  function unitLabel(p, qty) {
    var u = p.unitLabel || p.unit || 'pc';
    if (qty === 1) return u;
    if (u === 'pack of 10') return 'packs of 10';
    return u + 's';
  }

  /* Discount percentage that applies to a given quantity. */
  function discountFor(p, qty) {
    if (p.fixed || p.noDiscount) return 0;
    var pcs = qty * (p.packSize || 1);
    var pct = 0;
    for (var i = 0; i < DISCOUNT_TIERS.length; i++) {
      if (pcs >= DISCOUNT_TIERS[i].min) pct = DISCOUNT_TIERS[i].percent;
    }
    return pct;
  }

  root.NTAGZ_CATALOG = {
    products: products,
    tiers: DISCOUNT_TIERS,
    shipping: SHIPPING,
    byId: byId,
    moqFor: moqFor,
    unitLabel: unitLabel,
    discountFor: discountFor
  };

})(window);
