const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(new URL('../js/nfc-check.js', `file://${__filename}`), 'utf8');

// The reader must be released after a successful scan.
assert.match(source, /await reader\.scan\(\{ signal: controller\.signal \}\);\s*\/\/[^\n]*\n\s*controller\.abort\(\);/, 'scan must be aborted right after it succeeds');

// Specific failures get their own advice.
assert.match(source, /NotReadableError: "NFC is turned off/, 'NotReadableError must say NFC is turned off');
assert.match(source, /NotSupportedError: "No NFC hardware was found/, 'NotSupportedError must say no NFC hardware');

// Double taps are blocked while checking, and re-enabled on permission denial so the user can retry.
assert.match(source, /button\.disabled = true;/, 'button must be disabled while checking');
assert.match(source, /button\.disabled = false;/, 'button must be re-enabled after permission is denied');

// Supported Android browsers get a ready badge instead of a stuck "Checking Device...".
assert.match(source, /badge\.textContent = "Ready to check";/, 'supported browsers must show a ready badge');

// iPadOS reports a Mac user agent; detect it by touch support.
assert.match(source, /navigator\.platform === 'MacIntel' && navigator\.maxTouchPoints > 1/, 'iPadOS must be detected as iOS');

console.log('nfc-check checks passed');
