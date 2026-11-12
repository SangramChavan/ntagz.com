# NFC write and NFC check: bugs and fix plan

Scope: `programmer.html` + `js/programmer.js` (write/read tags) and `nfc-check.html` + `js/nfc-check.js` (capability check).
These files on this checkout are identical to `origin/main` (checked 2026-11-11). The site is served by GitHub Pages from `main`.

## Bugs

### Writer (`js/programmer.js`)

| # | Severity | Bug | Effect |
|---|----------|-----|--------|
| W1 | Critical | "Launch Android App" preset sends `{recordType: "android.com:pkg", data: "<string>"}`. Web NFC requires an external-type record's `data` to be bytes (BufferSource). | `write()` throws `TypeError` every time: this preset can never write. |
| W2 | High | The Read scan is never stopped. Each Read click starts another `NDEFReader.scan()` and adds more `reading` listeners; nothing aborts them. | After a Read, every tag tap during a Write fires `reading` and overwrites the log with "Success! Tag ID…", hiding the write result. Scans keep running for the life of the page. |
| W3 | High | Writes have no `AbortController`. Tapping Write again leaves the first write pending; it then rejects with `AbortError`. | User sees "Write failed: AbortError… (Is the tag locked or unsupported?)" for a write they replaced. No way to cancel. |
| W4 | High | Every failure shows "Is the tag locked or unsupported?". | NFC turned off (`NotReadableError`), permission denied (`NotAllowedError`), tag moved away mid-write (`NetworkError`), tag too small / not NDEF (`NotSupportedError`) all look the same, so users cannot fix the cause. |
| W5 | Medium | Validation only checks the built payload is non-empty. Defaults `https://`, and builders like `https://instagram.com/`, `tel:`, `mailto:?subject=` are non-empty. | Blank forms write junk URLs to tags. Invalid URLs (e.g. `https://` alone) are written. |
| W6 | Medium | On unsupported browsers (iPhone, desktop) Write shows "Simulated Write completed" in green success style. | Users believe the tag was written. This is the commonest "it says written but the tag does nothing" report. |

### Check page (`nfc-check.html`, `js/nfc-check.js`)

| # | Severity | Bug | Effect |
|---|----------|-----|--------|
| C1 | Medium | After a successful `scan()` the reader is never aborted. | Page keeps the NFC reader claimed, so tapping a tag while on the page does nothing (Android's normal tag handling is suppressed). |
| C2 | Medium | All non-permission errors show "antenna turned off or absent". | `NotReadableError` (NFC off) and `NotSupportedError` (no NFC hardware) need different advice. |
| C3 | Low | Button is not disabled while checking. | Double tap starts two scans. |
| C4 | Low | On a supported Android browser, badge stays "Checking Device..." until the button is pressed. | Looks stuck. |
| C5 | Low | iPad (iPadOS reports a Mac user agent) is not detected as iOS. | Gets generic "Not Supported" instead of the Apple explanation. |

### Both pages

| # | Severity | Bug | Effect |
|---|----------|-----|--------|
| S1 | Low | `<link rel="stylesheet" href="neumorphic.css">` points at the site root; the file is `css/neumorphic.css`. | 404; neumorphic styles missing on both pages. (Same broken link exists on ~12 other pages: out of scope, follow-up.) |

## Fix plan (minimal, no refactor)

`js/programmer.js`
1. W1: in `handleWrite`, when `currentRecordType` is an external type (contains `:`), send `data: new TextEncoder().encode(payload)`.
2. W2/W3: one module-level `let nfcAbort = null;` helper `startNfcOp()` that aborts the previous controller and returns a new one. Read and Write both call it and pass `{ signal }` to `scan()` / `write()`. Read registers listeners with `{ signal }` too (via `addEventListener(..., { signal })`) so aborted scans drop their listeners. Starting a write aborts any running scan.
3. W3/W4: add `describeNfcError(err)` mapping:
   - `AbortError` → "Cancelled." (style `wait`, not error)
   - `NotAllowedError` → "NFC permission was blocked. Allow NFC for this site in Chrome settings and try again."
   - `NotReadableError` → "NFC is turned off. Turn it on in Android Settings > Connected devices, then try again."
   - `NetworkError` → "The tag moved away before writing finished. Hold it still against the back of the phone and try again."
   - `NotSupportedError` → "This tag can't store this data (too small, locked, or not NDEF formatted). Try a shorter payload or another tag."
   - `TypeError`/`SyntaxError` → "The data isn't valid for this record type."
   - default → `Write failed: ${err.name}`.
   Use it for both read and write failures (prefix with "Read failed"/"Write failed").
4. W5: before writing, require every non-optional field to be non-blank after trim (mark optional fields with `optional: true` in presets: `wa_msg`, `email_sub`). For presets whose field `type` is `url`, check `new URL(value)` succeeds and protocol is `http:`/`https:`. Show a field-specific error and do not write.
5. W6: unsupported-browser Write shows style `error`: "Not written. This browser can't write NFC tags. Open this page in Chrome on Android." Keep the payload out of HTML (log uses `innerText`, already).
6. Keep existing hardening (test `test/programmer-hardening.test.js` must still pass: no `innerHTML` on banner, `log.innerText = msg`, `statusMessage` uses text nodes, simulated-write log must not interpolate `${currentPayloadData}`).

`js/nfc-check.js`
7. C1: create an `AbortController`, pass `{ signal }` to `scan()`, call `abort()` right after it resolves.
8. C2: `NotReadableError` → "NFC is turned off" text; `NotSupportedError` → "No NFC hardware found" text; others → current text.
9. C3: disable `actionBtn` while checking; re-enable on permission-denied so the user can retry.
10. C4: when supported, set badge to "Ready to check" in `runInitialEnvironmentCheck`.
11. C5: `isIOS` also true when `navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1`.

HTML
12. S1: change `href="neumorphic.css"` to `href="css/neumorphic.css"` in `nfc-check.html` and `programmer.html` only.

Tests
13. Extend `test/programmer-hardening.test.js` (static source asserts, same style): external-type write encodes bytes (`TextEncoder`), `scan(` and `write(` receive a `signal`, `AbortError` handled, `NotReadableError` mapped. Add `test/nfc-check.test.js` asserting `abort()` after scan and `NotSupportedError` branch. Run `node test/programmer-hardening.test.js && node test/nfc-check.test.js` and `node --check` on both JS files.

## Not verifiable here
Web NFC only runs in Chrome on a physical Android phone. Code checks, unit tests and a desktop-browser load (no console errors, simulation-mode message) are done here; a real tag write must be checked on an Android phone after deploy.

## Delivery
- Implement on a fresh branch from `origin/main` in a separate worktree (this checkout has 26 unrelated uncommitted changes on `fix/google-review-stand-hero-image`).
- Confirmed 2026-11-11: GitHub Pages source is `main` `/` (legacy build), proxied by Cloudflare; live NFC files == `origin/main`.
- CI (`ci.yml`) does NOT run the NFC tests; local tests + diff review are the gate.
- Deploy = PR to `main`, merge → GitHub Pages publishes. Then confirm `https://ntagz.com/js/programmer.js` serves the new code.
