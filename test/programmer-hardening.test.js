const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(new URL('../js/programmer.js', `file://${__filename}`), 'utf8');

assert.doesNotMatch(source, /banner\.innerHTML\s*=/, 'NFC capability status must not parse HTML strings');
assert.doesNotMatch(source, /showLog\(`Unsupported Device:[^`]*\$\{currentPayloadData\}/, 'simulated-write log must not interpolate user payload into markup');
assert.match(source, /function statusMessage[\s\S]*wrapper\.append\(strong, document\.createTextNode\(message\)\)/, 'status copy must be inserted as text nodes');
assert.match(source, /log\.innerText\s*=\s*msg/, 'user-controlled action messages must be rendered as text');
console.log('programmer hardening checks passed');
