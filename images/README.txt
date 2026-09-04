Real product photography is in place for all core products, plus supporting
spec-screenshot and use-case images. This folder's contents as of the last
update:

  anti-metal-tag.jpg           — Anti-Metal NFC Tag product photo (replaced
                                  2026-09-04 with a new white-background shot)
  black-nfc-card.png           — NFC Tools spec readout (used as the Black Card's
                                  primary image — no clean product photo yet)
  google-review-card.jpg       — "Tap to review on Google" card artwork, used on
                                  the card pages (replaced 2026-09-04 with the
                                  current design, re-encoded as JPEG for size)
  micro-flex-fpc.jpeg          — Micro Flex (FPC) size-variant photo
  mini-nfc-tag.jpeg            — Mini NFC Tag product photo
  mini-nfc-tag-spec.jpeg       — Mini NFC Tag spec readout (21×11mm, Mifare Ultralight)
  nfc-coin.jpeg                — NFC Coin 25mm product photo
  nfc-coin-spec.jpeg           — NFC Coin spec readout
  nfc-adhesive-tag.jpg         — NTAG216 Adhesive Tag product photo
  UHF-RFID-Label-Sticker-27x15mm.jpg
                                — UHF RFID label product photo. Converted from a
                                  553KB PNG to a resized, compressed JPEG
                                  (~107KB) on 2026-09-04 — only ever shown as a
                                  homepage/catalog thumbnail, so the original's
                                  1402×1122 resolution was pure page weight.
  white-nfc-card.jpeg          — White NFC Card product photo (also used for the
                                  Inkjet Printable Card, which shares the same blank
                                  card stock — no separate photo yet)
  white-nfc-card-specs.jpeg    — White Card spec readout (confirms NTAG216 — the
                                  original filename said "215" but the chip reading
                                  itself shows NTAG216, 924 bytes)
  black-nfc-card-info.jpg      — 7-layer card construction diagram. Not referenced
                                  by any page yet; compressed from 1.4MB PNG to
                                  ~350KB JPEG on 2026-09-04. Worth wiring into the
                                  Black Card product page as a spec diagram.

STILL NEEDED — no real photo exists yet for:
  logo.png              — site logo. Referenced in every nav/footer; currently
                            falls back gracefully to a plain inline icon via onerror.
  sample-kit             — no photo; product page shows a "photo coming soon" placeholder
  white-inkjet-nfc-card  — currently reusing the white-nfc-card photo; a distinct
                            photo showing the inkjet-printable coating/finish would
                            be more accurate once available

Favicons (favicon.ico, apple-touch-icon.png, favicon-16x16.png, favicon-32x32.png)
stay referenced from the SITE ROOT, not this folder — browsers look for them there
by convention. Copies of them also live in this folder from an earlier upload but
aren't referenced from here.

COMPRESSION: every product photo here is sized for its largest on-site use (mostly
homepage/catalog thumbnails and product-page images well under 900px) and saved as
JPEG unless it needs transparency, since JPEG compresses photographic content far
smaller than PNG at equivalent visual quality. Re-run this pass with `sips` (macOS)
or `cwebp`/`pngquant` if a new upload lands here oversized.
