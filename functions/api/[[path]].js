const PRODUCTS = {
  "sample-kit": { price: 1940, fixed: true, allInclusive: false },
  "black-nfc-card": { price: 30 },
  "white-nfc-card": { price: 25 },
  "white-inkjet-nfc-card": { price: 32.8 },
  "google-review-nfc-card": { price: 95 },
  "google-review-nfc-stand-5x5": { price: 99, allInclusive: true },
  "google-review-nfc-stand-10x10": { price: 149, allInclusive: true },
  "google-review-nfc-stand-12x12": { price: 199, allInclusive: true },
  "nfc-card-custom-printing": { price: 75 },
  "anti-metal-tag": { price: 20 },
  "ntag216-adhesive-tag": { price: 18 },
  "nfc-coin": { price: 20 },
  "mini-nfc-tag": { price: 16 },
  "micro-flex-fpc": { price: 75 },
  "nfc-wristband": { price: 80 },
  "uhf-rfid-label": { price: 249, packSize: 10, moq: 1 },
  "rfid-card-custom-printing": { price: 75 },
};

const corsHeaders = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin === "https://ntagz.com" ? origin : "https://www.ntagz.com", "Content-Type": "application/json" },
  });
}

function calculateTotal(items, state) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) return null;
  let regular = 0;
  let inclusive = 0;
  let pieces = 0;

  for (const item of items) {
    const product = PRODUCTS[item?.id];
    const qty = item?.qty;
    if (!product || !Number.isSafeInteger(qty) || qty < (product.fixed ? 1 : product.moq || 10) || qty > 100000) return null;
    if (product.fixed && qty !== 1) return null;
    const linePieces = qty * (product.packSize || 1);
    const discount = product.fixed ? 0 : linePieces >= 5000 ? 25 : linePieces >= 1000 ? 15 : linePieces >= 500 ? 10 : 0;
    const net = product.price * qty * (100 - discount) / 100;
    if (product.allInclusive) inclusive += net;
    else regular += net;
    pieces += product.fixed ? 70 : linePieces;
  }

  const taxable = regular + inclusive;
  const shipping = state
    ? inclusive > 0 || taxable >= 2000 ? 0 : state === "Maharashtra" ? 40 : 80
    : 0;
  const amount = Math.round(regular + Math.round(regular * 0.18) + inclusive + shipping);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000000) return null;
  return { amount, pieces };
}

async function razorpayRequest(path, env, body) {
  const credentials = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Razorpay order creation failed");
  return data;
}

async function verifySignature(orderId, paymentId, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${orderId}|${paymentId}`)
  ));
  const expected = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  if (typeof signature !== "string" || signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function sha512(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function payuHash(fields, salt) {
  return sha512([
    fields.key, fields.txnid, fields.amount, fields.productinfo, fields.firstname, fields.email,
    fields.udf1 || "", fields.udf2 || "", fields.udf3 || "", fields.udf4 || "", fields.udf5 || "",
    "", "", "", "", "", salt,
  ].join("|"));
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function verifyPayuResponse(body, salt) {
  if (typeof body.hash !== "string" || typeof body.txnid !== "string" || typeof body.status !== "string" ||
      typeof body.key !== "string" || typeof body.amount !== "string" || typeof body.productinfo !== "string" ||
      typeof body.firstname !== "string" || typeof body.email !== "string") return false;
  if ([body.key, body.txnid, body.amount, body.productinfo, body.firstname, body.email,
    body.udf1 || "", body.udf2 || "", body.udf3 || "", body.udf4 || "", body.udf5 || ""].some(value => value.includes("|"))) return false;
  const responseHash = await sha512([
    salt, body.status, "", "", "", "", "", body.udf5 || "", body.udf4 || "", body.udf3 || "",
    body.udf2 || "", body.udf1 || "", body.email || "", body.firstname || "", body.productinfo || "",
    body.amount || "", body.txnid, body.key,
  ].join("|"));
  return safeEqual(responseHash, body.hash.toLowerCase());
}

async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const responseHeaders = { ...corsHeaders, "Access-Control-Allow-Origin": origin === "https://ntagz.com" ? origin : "https://www.ntagz.com" };
  if (request.method === "OPTIONS") return new Response(null, { headers: responseHeaders });
  const payuReturn = url.pathname.endsWith("/payu/success") || url.pathname.endsWith("/payu/failure");
  if (request.method !== "POST" && !(request.method === "GET" && (url.pathname.endsWith("/payu/verify-payment") || payuReturn))) return json({ error: "Method not allowed" }, 405, origin);
  const payuCallback = payuReturn || url.pathname.endsWith("/payu/verify-payment");
  if (origin && !["https://www.ntagz.com", "https://ntagz.com"].includes(origin)) {
    return json({ error: "Origin not allowed" }, 403, origin);
  }
  if (!payuCallback && !url.pathname.endsWith("/payu/checkout") &&
      !url.pathname.endsWith("/create-order") && !url.pathname.endsWith("/verify-payment")) return json({ error: "Not found" }, 404, origin);
  if (!payuCallback && url.pathname.endsWith("/create-order") && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
    return json({ error: "Razorpay is not configured" }, 503, origin);
  }
  if (!payuCallback && url.pathname.endsWith("/verify-payment") &&
      (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) return json({ error: "Razorpay is not configured" }, 503, origin);
  let body;
  try {
    if (Number(request.headers.get("Content-Length")) > 10000) return json({ error: "Request too large" }, 413, origin);
    if (payuCallback && request.method === "GET") body = Object.fromEntries(url.searchParams.entries());
    else if (payuCallback && request.headers.get("Content-Type")?.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(await request.text()));
    }
    else body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, origin);
  }

  if (payuCallback) {
    try {
      if (!env.PAYU_KEY || !env.PAYU_SALT) return json({ error: "PayU is not configured" }, 503, origin);
      if (!await verifyPayuResponse(body, env.PAYU_SALT)) throw new Error("Invalid PayU payment signature");
      if (body.key !== env.PAYU_KEY) throw new Error("Invalid PayU payment response");
      let transaction;
      if (body.status === "success") {
        const verificationHash = await sha512(`${env.PAYU_KEY}|verify_payment|${body.txnid}|${env.PAYU_SALT}`);
        const verification = await fetch(env.PAYU_ENV === "test"
          ? "https://test.payu.in/merchant/postservice.php?form=2"
          : "https://info.payu.in/merchant/postservice.php?form=2", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ key: env.PAYU_KEY, command: "verify_payment", var1: body.txnid, hash: verificationHash }),
        });
        if (!verification.ok) throw new Error("PayU payment verification failed");
        const result = await verification.json();
        transaction = result.transaction_details?.[body.txnid];
        if (result.status !== 1 || transaction?.status !== "success" ||
            !safeEqual(String(transaction?.amount || ""), body.amount) || transaction?.txnid !== body.txnid) {
          throw new Error("PayU could not confirm this payment");
        }
      } else {
        transaction = { status: body.status };
      }
      const isSuccess = body.status === "success";
      const confirmParams = new URLSearchParams({
        status: isSuccess ? "success" : "failed",
        gateway: "payu",
        ...(body.txnid  && { txnid:  body.txnid }),
        ...(body.amount && { amount: body.amount }),
      });
      return Response.redirect(`https://www.ntagz.com/order/confirm.html?${confirmParams}`, 303);
    } catch (error) {
      const confirmParams = new URLSearchParams({ status: "failed", gateway: "payu" });
      return Response.redirect(`https://www.ntagz.com/order/confirm.html?${confirmParams}`, 303);
    }
  }

  try {
    if (url.pathname.endsWith("/create-order")) {
      const total = calculateTotal(body.items, body.state);
      if (!total) return json({ error: "Invalid order" }, 400, origin);
      const order = await razorpayRequest("/orders", env, {
        amount: total.amount * 100,
        currency: "INR",
        receipt: `ntagz_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
        notes: {
          quote_ref: typeof body.quoteRef === "string" ? body.quoteRef.slice(0, 32) : "",
          pieces: String(total.pieces),
        },
      });
      return json({ id: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID }, 200, origin);
    }

    if (url.pathname.endsWith("/verify-payment")) {
      const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;
      if (![orderId, paymentId, signature].every(value => typeof value === "string" && value.length <= 128)) {
        return json({ error: "Invalid payment response" }, 400, origin);
      }
      if (!await verifySignature(orderId, paymentId, signature, env.RAZORPAY_KEY_SECRET)) {
        return json({ error: "Invalid payment signature" }, 400, origin);
      }
      return json({ status: "verified", paymentId, orderId }, 200, origin);
    }

    if (url.pathname.endsWith("/payu/checkout")) {
      if (!env.PAYU_KEY || !env.PAYU_SALT) return json({ error: "PayU is not configured" }, 503, origin);
      const total = calculateTotal(body.items, body.state);
      if (!total) return json({ error: "Invalid order" }, 400, origin);
      const firstName = typeof body.name === "string" ? body.name.trim().split(/\s+/)[0].slice(0, 60) : "";
      const email = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
      const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "").slice(-10) : "";
      if (!firstName || /[|<>]/.test(firstName) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[|<>]/.test(email) || !/^\d{10}$/.test(phone)) {
        return json({ error: "Enter a valid name, email, and 10-digit phone number for PayU" }, 400, origin);
      }
      const fields = {
        key: env.PAYU_KEY,
        txnid: `ntagz${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        amount: total.amount.toFixed(2),
        productinfo: `nTagz order ${(typeof body.quoteRef === "string" ? body.quoteRef : "").replace(/[^\w-]/g, "").slice(0, 20)}`,
        firstname: firstName,
        email,
        phone,
        surl: "https://ntagz-payments.ambivert.workers.dev/api/payu/success",
        furl: "https://ntagz-payments.ambivert.workers.dev/api/payu/failure",
        curl: "https://ntagz-payments.ambivert.workers.dev/api/payu/failure",
      };
      fields.hash = await payuHash(fields, env.PAYU_SALT);
      return json({ action: env.PAYU_ENV === "test" ? "https://test.payu.in/_payment" : "https://secure.payu.in/_payment", fields }, 200, origin);
    }

  if (url.pathname.endsWith("/payu/verify-payment") || url.pathname.endsWith("/payu/success") || url.pathname.endsWith("/payu/failure")) {
      if (!env.PAYU_SALT) return json({ error: "PayU is not configured" }, 503, origin);
      if (!await verifyPayuResponse(body, env.PAYU_SALT)) return json({ error: "Invalid PayU payment signature" }, 400, origin);
      const verificationHash = await sha512(`${env.PAYU_KEY}|verify_payment|${body.txnid}|${env.PAYU_SALT}`);
      const verification = await fetch(env.PAYU_ENV === "test"
        ? "https://test.payu.in/merchant/postservice.php?form=2"
        : "https://info.payu.in/merchant/postservice.php?form=2", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key: env.PAYU_KEY, command: "verify_payment", var1: body.txnid, hash: verificationHash }),
      });
      if (!verification.ok) throw new Error("PayU payment verification failed");
      const result = await verification.json();
      const transaction = result.transaction_details?.[body.txnid];
      if (result.status !== 1 || transaction?.status !== "success" ||
          !safeEqual(String(transaction?.amount || ""), body.amount) || transaction?.txnid !== body.txnid) {
        return json({ error: "PayU could not confirm this payment" }, 402, origin);
      }
      if (transaction.status !== "success") return json({ error: "PayU reports this payment was not successful" }, 402, origin);
      return json({ status: "verified", paymentId: String(body.mihpayid || "").slice(0, 128), orderId: body.txnid }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  } catch (error) {
    console.error("Payment request failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Payment request failed" }, 502, origin);
  }
}

if (typeof module !== "undefined") module.exports = { onRequest, calculateTotal, verifySignature, payuHash, verifyPayuResponse };
