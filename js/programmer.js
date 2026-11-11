/**
     * Ntagz Web NFC Programmer Logic
     */

    const presets = {
      website: {
        type: "url",
        fields: [{ id: "url_input", label: "Website URL", type: "url", placeholder: "https://yourwebsite.com", default: "https://" }],
        build: (data) => data.url_input
      },
      instagram: {
        type: "url",
        fields: [{ id: "ig_handle", label: "Instagram Username (without @)", type: "text", placeholder: "ntagz_official", default: "" }],
        build: (data) => `https://instagram.com/${data.ig_handle}`
      },
      contact: {
        type: "url",
        fields: [{ id: "contact_url", label: "vCard or Linktree URL", type: "url", placeholder: "https://linktr.ee/yourname", default: "https://" }],
        build: (data) => data.contact_url
      },
      payment: {
        type: "url",
        fields: [{ id: "pay_url", label: "Payment Link (PayPal.me, Razorpay, etc.)", type: "url", placeholder: "https://paypal.me/yourusername", default: "https://" }],
        build: (data) => data.pay_url
      },
      whatsapp: {
        type: "url",
        fields: [
          { id: "wa_phone", label: "Phone Number (with Country Code)", type: "text", placeholder: "919960160016", default: "" },
          { id: "wa_msg", label: "Pre-filled Message (Optional)", type: "text", placeholder: "Hi ntagz!", default: "", optional: true }
        ],
        build: (data) => `https://wa.me/${data.wa_phone}?text=${encodeURIComponent(data.wa_msg)}`
      },
      email: {
        type: "url",
        fields: [
          { id: "email_address", label: "Email Address", type: "email", placeholder: "hello@ntagz.in", default: "" },
          { id: "email_sub", label: "Subject Line", type: "text", placeholder: "Inquiry", default: "", optional: true }
        ],
        build: (data) => `mailto:${data.email_address}?subject=${encodeURIComponent(data.email_sub)}`
      },
      sms: {
        type: "url",
        fields: [
          { id: "sms_phone", label: "Phone Number", type: "text", placeholder: "+919960160016", default: "" },
          { id: "sms_body", label: "Message", type: "text", placeholder: "Hello!", default: "" }
        ],
        build: (data) => `sms:${data.sms_phone}?body=${encodeURIComponent(data.sms_body)}`
      },
      phone: {
        type: "url",
        fields: [{ id: "tel_phone", label: "Phone Number", type: "text", placeholder: "+919960160016", default: "" }],
        build: (data) => `tel:${data.tel_phone}`
      },
      app: {
        type: "android.com:pkg",
        fields: [{ id: "pkg_name", label: "Android Package Name", type: "text", placeholder: "com.whatsapp", default: "" }],
        build: (data) => data.pkg_name
      },
      text: {
        type: "text",
        fields: [{ id: "text_note", label: "Text Note", type: "textarea", placeholder: "Enter your secure note, serial number, or data here...", default: "" }],
        build: (data) => data.text_note
      }
    };

    // DOM Elements
    const banner = document.getElementById('status-banner');
    const selector = document.getElementById('preset-selector');
    const inputsContainer = document.getElementById('dynamic-inputs-container');
    const previewType = document.getElementById('preview-type');
    const previewData = document.getElementById('preview-data');
    const btnRead = document.getElementById('btn-read');
    const btnWrite = document.getElementById('btn-write');
    const log = document.getElementById('action-log');

    // State Manager
    let currentPayloadData = "";
    let currentRecordType = "url";
    let nfcSupported = false;
    let nfcAbort = null;

    // Bootloader Initialization
    function init() {
      checkNfcSupport();
      renderInputs(selector.value);
      selector.addEventListener('change', (e) => renderInputs(e.target.value));
      btnRead.addEventListener('click', handleRead);
      btnWrite.addEventListener('click', handleWrite);
    }

    // Environmental Hardware Check
    function checkNfcSupport() {
      if ('NDEFReader' in window) {
        nfcSupported = true;
        banner.className = 'status-banner supported';
        banner.replaceChildren(
          makeStatusIcon(true),
          statusMessage('Web NFC Supported.', 'Your browser can read and write NFC tags. Ensure NFC is turned on in your device settings.')
        );
      } else {
        nfcSupported = false;
        banner.className = 'status-banner unsupported';
        banner.replaceChildren(
          makeStatusIcon(false),
          statusMessage('Simulation Mode.', 'Web NFC requires Chrome on Android. You can test the interface here, but you cannot write to physical tags on this device.')
        );
      }
    }

    function makeStatusIcon(supported) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      if (supported) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        check.setAttribute('points', '22 4 12 14.01 9 11.01');
        svg.append(path, check);
      } else {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '10');
        const stem = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stem.setAttribute('x1', '12'); stem.setAttribute('y1', '8'); stem.setAttribute('x2', '12'); stem.setAttribute('y2', '12');
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        dot.setAttribute('x1', '12'); dot.setAttribute('y1', '16'); dot.setAttribute('x2', '12.01'); dot.setAttribute('y2', '16');
        svg.append(circle, stem, dot);
      }
      return svg;
    }

    function statusMessage(title, message) {
      const wrapper = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = title + ' ';
      wrapper.append(strong, document.createTextNode(message));
      return wrapper;
    }

    function showLog(msg, type) {
      log.className = `log-${type}`;
      log.innerText = msg;
    }

    // Each Read or Write gets a fresh controller; starting one aborts the previous one.
    function startNfcOp() {
      if (nfcAbort) nfcAbort.abort();
      nfcAbort = new AbortController();
      return nfcAbort;
    }

    // Maps Web NFC error names to advice the user can act on.
    function describeNfcError(err, prefix) {
      const name = err && err.name;
      if (name === 'AbortError') return { text: 'Cancelled.', style: 'wait' };
      const advice = {
        NotAllowedError: 'NFC permission was blocked. Allow NFC for this site in Chrome settings and try again.',
        NotReadableError: 'NFC is turned off. Turn it on in Android Settings > Connected devices, then try again.',
        NetworkError: 'The tag moved away before writing finished. Hold it still against the back of the phone and try again.',
        NotSupportedError: "This tag can't store this data (too small, locked, or not NDEF formatted). Try a shorter payload or another tag.",
        TypeError: "The data isn't valid for this record type.",
        SyntaxError: "The data isn't valid for this record type."
      }[name];
      return { text: `${prefix}: ${advice || name}`, style: 'error' };
    }

    // Returns a message for the first invalid field, or '' when the form is valid.
    function validateFields(preset) {
      for (const field of preset.fields) {
        const value = document.getElementById(field.id).value.trim();
        if (!value) {
          if (field.optional) continue;
          return `${field.label} is required.`;
        }
        if (field.type === 'url') {
          let ok = false;
          try {
            const u = new URL(value);
            ok = u.protocol === 'http:' || u.protocol === 'https:';
          } catch (e) { ok = false; }
          if (!ok) return `${field.label} must be a full link starting with http:// or https://.`;
        }
      }
      return '';
    }

    // Render dynamic contextual inputs based on layout configurations
    function renderInputs(presetKey) {
      const preset = presets[presetKey];
      currentRecordType = preset.type;
      inputsContainer.innerHTML = '';

      preset.fields.forEach(field => {
        const group = document.createElement('div');
        group.className = 'form-group';

        const label = document.createElement('label');
        label.htmlFor = field.id;
        label.innerText = field.label;
        group.appendChild(label);

        let input;
        if (field.type === 'textarea') {
          input = document.createElement('textarea');
          input.className = 'form-control';
        } else {
          input = document.createElement('input');
          input.type = field.type;
          input.className = 'form-control';
        }

        input.id = field.id;
        input.placeholder = field.placeholder;
        input.value = field.default;
        input.addEventListener('input', updatePreview);

        group.appendChild(input);
        inputsContainer.appendChild(group);
      });

      updatePreview();
    }

    // Live Node Preview Generator
    function updatePreview() {
      const presetKey = selector.value;
      const preset = presets[presetKey];

      const dataObj = {};
      preset.fields.forEach(field => {
        dataObj[field.id] = document.getElementById(field.id).value.trim();
      });

      currentPayloadData = preset.build(dataObj);

      previewType.innerText = `Record Type: ${currentRecordType}`;
      previewData.innerText = currentPayloadData || "[Empty Payload]";
    }

    // Execute Transceiver NDEF Read
    async function handleRead() {
      if (!nfcSupported) {
        showLog("Unsupported Device: Cannot read physical tag. (Simulated Read Error)", "error");
        return;
      }

      const ctrl = startNfcOp();
      try {
        showLog("Scanning... Bring an NFC tag near your phone's antenna.", "wait");
        const ndef = new NDEFReader();
        await ndef.scan({ signal: ctrl.signal });

        ndef.addEventListener("readingerror", () => {
          showLog("Error reading tag. Try repositioning.", "error");
        }, { signal: ctrl.signal });

        ndef.addEventListener("reading", ({ message, serialNumber }) => {
          let recordsInfo = `Tag ID: ${serialNumber} | Records: ${message.records.length}\n`;
          for (const record of message.records) {
            recordsInfo += `- Type: ${record.recordType}\n`;
          }
          showLog(`Success! \n${recordsInfo}`, "success");
        }, { signal: ctrl.signal });
      } catch (error) {
        if (ctrl !== nfcAbort) return; // a newer Read or Write owns the log now
        const { text, style } = describeNfcError(error, "Read failed");
        showLog(text, style);
      }
    }

    // Execute Transceiver NDEF Write
    // Validation is synchronous and nothing awaits before ndef.write(): Web NFC needs the click's user activation.
    async function handleWrite() {
      const problem = validateFields(presets[selector.value]);
      if (problem) {
        showLog(problem, "error");
        return;
      }

      if (!nfcSupported) {
        showLog("Not written. This browser can't write NFC tags. Open this page in Chrome on Android.", "error");
        return;
      }

      const ctrl = startNfcOp();
      try {
        showLog("Ready to write. Hold the NFC tag to your phone now.", "wait");
        const ndef = new NDEFReader();

        // External types (e.g. "android.com:pkg") require BufferSource data.
        const record = {
          recordType: currentRecordType,
          data: currentRecordType.includes(':') ? new TextEncoder().encode(currentPayloadData) : currentPayloadData
        };

        await ndef.write({ records: [record] }, { signal: ctrl.signal });
        showLog(`Success! Written to tag: ${currentPayloadData}`, "success");
      } catch (error) {
        if (ctrl !== nfcAbort) return; // superseded by a newer Read or Write
        const { text, style } = describeNfcError(error, "Write failed");
        showLog(text, style);
      }
    }

    window.addEventListener('DOMContentLoaded', init);
