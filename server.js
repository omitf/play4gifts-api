import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== SIMPLE IN-MEMORY STORAGE (MVP) ======
// Later you can replace with a DB (Postgres).
const payments = new Map(); // payment_id -> { status, email, token, expiresAt }
const tokens = new Map();   // token -> { expiresAt, tiktokUsername, payment_id }

function makeToken() {
  return crypto.randomBytes(16).toString("hex").toUpperCase(); // 32 chars
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Health check
app.get("/", (req, res) => res.json({ ok: true }));

// ====== NOWPayments Webhook ======
// Set your NOWPayments IPN/Webhook URL to:
// https://YOUR-RAILWAY-URL/webhook/nowpayments
app.post("/webhook/nowpayments", (req, res) => {
  // NOTE: For MVP we don't verify signature. We'll add later if you want.
  const body = req.body;

  const payment_id = String(body.payment_id ?? body.id ?? "");
  const payment_status = String(body.payment_status ?? body.status ?? "").toLowerCase();
  const email = String(body.email ?? "");

  if (!payment_id) return res.status(400).json({ ok: false, error: "Missing payment_id" });

  // Save/update payment
  let p = payments.get(payment_id) || { status: "unknown", email, token: null, expiresAt: null };
  p.status = payment_status;
  if (email) p.email = email;

  // If confirmed, generate a token if not already
  if (payment_status === "confirmed" && !p.token) {
    const token = makeToken();
    const expiresAt = addDays(new Date(), 30).toISOString();

    p.token = token;
    p.expiresAt = expiresAt;

    tokens.set(token, { expiresAt, tiktokUsername: null, payment_id });
  }

  payments.set(payment_id, p);
  return res.json({ ok: true });
});

// ====== User checks their payment_id to receive token (optional) ======
app.get("/token-by-payment/:paymentId", (req, res) => {
  const paymentId = String(req.params.paymentId);
  const p = payments.get(paymentId);
  if (!p) return res.status(404).json({ ok: false, error: "Payment not found" });

  if (p.status !== "confirmed") {
    return res.json({ ok: false, status: p.status });
  }

  return res.json({ ok: true, token: p.token, expiresAt: p.expiresAt });
});

// ====== Game activates token with TikTok username ======
app.post("/activate", (req, res) => {
  const token = String(req.body.token ?? "").trim().toUpperCase();
  const tiktokUsername = String(req.body.tiktokUsername ?? "").trim();

  if (!token || !tiktokUsername) {
    return res.status(400).json({ ok: false, error: "token and tiktokUsername are required" });
  }

  const t = tokens.get(token);
  if (!t) return res.status(404).json({ ok: false, error: "Invalid token" });

  const now = new Date();
  const exp = new Date(t.expiresAt);
  if (now > exp) return res.json({ ok: false, error: "Expired", expiresAt: t.expiresAt });

  // Bind token to username (first activation). If already bound, must match.
  if (t.tiktokUsername && t.tiktokUsername.toLowerCase() !== tiktokUsername.toLowerCase()) {
    return res.status(403).json({ ok: false, error: "Token already bound to another username" });
  }

  t.tiktokUsername = tiktokUsername;
  tokens.set(token, t);

  return res.json({ ok: true, expiresAt: t.expiresAt });
});

// ====== Game checks token validity ======
app.post("/check", (req, res) => {
  const token = String(req.body.token ?? "").trim().toUpperCase();
  if (!token) return res.status(400).json({ ok: false, error: "token is required" });

  const t = tokens.get(token);
  if (!t) return res.status(404).json({ ok: false, error: "Invalid token" });

  const now = new Date();
  const exp = new Date(t.expiresAt);
  if (now > exp) return res.json({ ok: false, error: "Expired", expiresAt: t.expiresAt });

  return res.json({ ok: true, expiresAt: t.expiresAt, tiktokUsername: t.tiktokUsername });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on port", PORT));
