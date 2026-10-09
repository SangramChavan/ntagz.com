const assert = require("node:assert/strict");
const { calculateTotal, verifySignature, payuHash, verifyPayuResponse } = require("../functions/api/[[path]].js");

async function main() {
  assert.equal(calculateTotal([{ id: "black-nfc-card", qty: 10 }], "Maharashtra").amount, 394);
  assert.equal(calculateTotal([{ id: "anti-metal-tag", qty: 500 }], "Maharashtra").amount, 10620);
  assert.equal(calculateTotal([{ id: "sample-kit", qty: 1 }], "").amount, 2289);
  assert.equal(calculateTotal([{ id: "made-up", qty: 10 }], "Maharashtra"), null);
  assert.equal(calculateTotal([{ id: "black-nfc-card", qty: 9 }], "Maharashtra"), null);
  assert.equal(calculateTotal([{ id: "sample-kit", qty: 2 }], "Maharashtra"), null);

  const secret = "test-secret";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("order_1|pay_1")));
  const hex = Array.from(sig, byte => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifySignature("order_1", "pay_1", hex, secret), true);
  assert.equal(await verifySignature("order_1", "pay_2", hex, secret), false);

  const payuFields = {
    key: "test-key", txnid: "ntagz123", amount: "394.00", productinfo: "nTagz order QT-123",
    firstname: "Test", email: "test@example.com", phone: "9999999999",
  };
  const payuSalt = "test-salt";
  const requestHash = await payuHash(payuFields, payuSalt);
  assert.equal(requestHash.length, 128);
  const payuResponse = {
    ...payuFields, status: "success", mihpayid: "payu_1", hash: "",
  };
  const responseHashInput = [payuSalt, payuResponse.status, "", "", "", "", "", "", "", "", "", "", payuResponse.email, payuResponse.firstname, payuResponse.productinfo, payuResponse.amount, payuResponse.txnid, payuResponse.key].join("|");
  payuResponse.hash = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(responseHashInput))
    .then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""));
  assert.equal(await verifyPayuResponse(payuResponse, payuSalt), true);
  const tamperedResponse = { ...payuResponse, amount: "1.00" };
  assert.equal(await verifyPayuResponse(tamperedResponse, payuSalt), false);

  const env = { PAYU_KEY: "test-key", PAYU_SALT: payuSalt, PAYU_ENV: "test" };
  const checkout = await require("../functions/api/[[path]].js").onRequest({
    request: new Request("https://ntagz-payments.ambivert.workers.dev/api/payu/checkout", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://www.ntagz.com" },
      body: JSON.stringify({ items: [{ id: "black-nfc-card", qty: 10 }], state: "Maharashtra", name: "Test Person", phone: "9999999999", email: "test@example.com" }),
    }), env,
  });
  assert.equal(checkout.status, 200);
  const checkoutData = await checkout.json();
  assert.equal(checkoutData.action, "https://test.payu.in/_payment");
  assert.equal(await payuHash(checkoutData.fields, payuSalt), checkoutData.fields.hash);
  assert.equal(checkoutData.fields.amount, "394.00");
  assert.equal(checkoutData.fields.surl, "https://ntagz-payments.ambivert.workers.dev/api/payu/success");

  const mockedFetch = global.fetch;
  const validPayuResponse = { ...payuResponse };
  validPayuResponse.hash = payuResponse.hash;
  global.fetch = async (_url, options) => {
    const verifyRequest = new URLSearchParams(options.body);
    assert.equal(verifyRequest.get("command"), "verify_payment");
    assert.equal(verifyRequest.get("var1"), validPayuResponse.txnid);
    return Response.json({
      status: 1,
      transaction_details: {
        [validPayuResponse.txnid]: { status: "success", amount: validPayuResponse.amount, txnid: validPayuResponse.txnid },
      },
    });
  };
  const payuReturn = await require("../functions/api/[[path]].js").onRequest({
    request: new Request("https://ntagz-payments.ambivert.workers.dev/api/payu/verify-payment", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayuResponse),
    }), env,
  });
  assert.equal(payuReturn.status, 303);
  const location = new URL(payuReturn.headers.get("Location"));
  assert.equal(location.pathname, "/order/confirm.html");
  assert.equal(location.searchParams.get("status"), "success");
  assert.equal(location.searchParams.get("txnid"), validPayuResponse.txnid);
  global.fetch = mockedFetch;
  console.log("payment worker checks passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
