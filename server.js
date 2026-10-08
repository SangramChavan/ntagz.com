const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Razorpay webhook secret (should be stored securely in production)
const RAZORPAY_WEBHOOK_SECRET = "whsec_your_razorpay_webhook_secret";

// Serve static files
app.use(express.static("."));
app.use(express.json({ limit: "10kb" }));

// Health check
app.get("/health", (req, res) => {
  res.send("OK");
});

// Serve the order page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "order.html"));
});

// Create Razorpay order
app.post("/api/create-order", (req, res) => {
  const { amount } = req.body;
  
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  
  // In a real implementation, you would create an order via the Razorpay API
  // For now, we return a mock response
  const mockOrder = {
    id: "order_rcptc12345678",
    amount: amount,
    currency: "INR",
    receipt: "receipt_order_74391",
    short_id: "order_74391"
  };
  
  res.json({
    id: mockOrder.id,
    amount: amount,
    currency: mockOrder.currency
  });
});

// Payment success webhook endpoint
app.post("/api/payment-success", (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    order_amount
  } = req.body;
  
  // Verify the payment signature
  const sign = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest("hex");
  
  if (sign === razorpay_signature) {
    // Payment is verified - fulfill the order
    console.log("Payment verified successfully:");
    console.log("  Payment ID:", razorpay_payment_id);
    console.log("  Order ID:", razorpay_order_id);
    console.log("  Amount:", order_amount);
    
    // TODO: Fulfill the order, send confirmation email, update database, etc.
    // You can here:
    // - Update the order status in your database
    // - Send a confirmation email to the customer
    // - Trigger WhatsApp notification
    // - Update inventory, etc.
    
    res.json({ status: "verified", message: "Payment verified successfully" });
  } else {
    res.status(400).json({ error: "Invalid signature" });
  }
});

// Payment webhook receiver (for Razorpay events)
app.post("/api/razorpay-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const webhookSignature = req.headers["x-razorpay-signature"];
  
  if (!webhookSignature) {
    return res.status(400).send("Missing signature");
  }
  
  // Verify webhook signature
  const secret = RAZORPAY_WEBHOOK_SECRET;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(req.body)
    .digest("hex");
  
  if (hmac !== webhookSignature) {
    return res.status(400).send("Invalid signature");
  }
  
  const event = JSON.parse(req.body.toString());
  const eventType = event.event;
  const data = event.payload.payment.entity;
  
  console.log("Razorpay webhook event:", eventType);
  
  if (eventType === "payment.authorized" || eventType === "payment.captured") {
    // Payment succeeded - fulfill order
    const paymentId = data.id;
    const orderId = data.order_id;
    const amount = data.amount;
    
    console.log("Payment succeeded:", paymentId, "amount:", amount);
    
    // Check for duplicate
    // TODO: Implement idempotency check
    
    // Fulfill the order
    // ... fulfill order logic
  }
  
  res.status(200).send("OK");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view the order page`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/api/razorpay-webhook`);
});