const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(new URL('../js/programmer.js', `file://${__filename}`), 'utf8');

assert.doesNotMatch(source, /banner\.innerHTML\s*=/, 'NFC capability status must not parse HTML strings');
assert.doesNotMatch(source, /showLog\(`Unsupported Device:[^`]*\$\{currentPayloadData\}/, 'simulated-write log must not interpolate user payload into markup');
assert.match(source, /function statusMessage[\s\S]*wrapper\.append\(strong, document\.createTextNode\(message\)\)/, 'status copy must be inserted as text nodes');
assert.match(source, /log\.innerText\s*=\s*msg/, 'user-controlled action messages must be rendered as text');

// innerHTML may only be used to clear the inputs container.
assert.doesNotMatch(source, /innerHTML\s*=(?!\s*'')/, 'only innerHTML = \'\' is allowed');

// External-type records (e.g. "android.com:pkg") must send BufferSource data.
assert.match(source, /currentRecordType\.includes\(':'\) \? new TextEncoder\(\)\.encode\(currentPayloadData\)/, 'external record data must be encoded to bytes');

// Read and Write are cancellable and share one controller.
assert.match(source, /await ndef\.scan\(\{ signal: ctrl\.signal \}\)/, 'scan must receive the abort signal');
assert.match(source, /await ndef\.write\(\{ records: \[record\] \}, \{ signal: ctrl\.signal \}\)/, 'write must receive the abort signal');
assert.equal(source.match(/\}, \{ signal: ctrl\.signal \}\);/g).length, 3, 'reading, readingerror and write-related listeners must be tied to the signal');
assert.match(source, /if \(nfcAbort\) nfcAbort\.abort\(\);/, 'starting an operation must abort the previous one');
assert.equal(source.match(/if \(ctrl !== nfcAbort\) return;/g).length, 2, 'superseded Read and Write must not overwrite the log');
assert.match(source, /name === 'AbortError'\) return \{ text: 'Cancelled\.', style: 'wait' \}/, 'AbortError must show Cancelled in wait style');

// Specific Web NFC errors get actionable text instead of a generic message.
for (const name of ['NotAllowedError', 'NotReadableError', 'NetworkError', 'NotSupportedError']) {
  assert.match(source, new RegExp(`${name}: ['"]`), `${name} must have its own message`);
}

// Web NFC needs user activation: nothing may await between the click and ndef.write().
const writeStart = source.indexOf('async function handleWrite');
const writeCall = source.indexOf('await ndef.write(');
assert.ok(writeStart > 0 && writeCall > writeStart, 'handleWrite must contain the write call');
assert.doesNotMatch(source.slice(writeStart, writeCall), /\bawait\b/, 'no await may run before ndef.write()');

// Optional fields are the only ones allowed to be blank.
assert.match(source, /id: "wa_msg"[^}]*optional: true/, 'WhatsApp message must be optional');
assert.match(source, /id: "email_sub"[^}]*optional: true/, 'email subject must be optional');

console.log('programmer hardening checks passed');
