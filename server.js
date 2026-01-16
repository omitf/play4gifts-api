// server.js
import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

// Postgres connection (Railway provides DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres typically requires SSL
  ssl: { rejectUnauthorized: false }
});

const app = express();

// Parse JSON bodies (NOWPayments sends JSON)
app.use(express.json({ limit: "1mb" }));

// CORS so your Cloudflare claim.html can call this API
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ====== SIMPLE IN-MEMORY STORAGE (MVP) ======
// NOTE: Will reset on Railway restart/redeploy.
const payments = new Map(); // payment_id -> { status, token, expiresAt, email, updatedAt }
const tokens = new Map();   // token -> { expiresAt, tiktokUsername, payment_id, createdAt }

function makeToken() {
  return crypto.randomBytes(16).toString("hex").toUpperCase(); // 32 chars
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function normalizeStatus(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    return res.json({ ok: true, db: r.rows[0] });
  } catch (e) {
    console.error("DB TEST ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Health check
app.get("/", (req, res) => res.json({ ok: true }));

// Optional debug: see recent payment ids (remove later)
app.get("/debug/payments", (req, res) => {
  const list = [];
  for (const [payment_id, p] of payments.entries()) {
    list.push({ payment_id, ...p });
  }
  res.json({ ok: true, count: list.length, payments: list.slice(-50) });
});

// ====== NOWPayments Webhook ======
// Set NOWPayments IPN/Webhook URL to:
// https://YOUR-RAILWAY-DOMAIN/webhook/nowpayments
//app.post("/webhook/nowpayments", (req, res) => {
app.post("/webhook/nowpayments", async (req, res) => {	
  const body = req.body || {};

  // Log the webhook so you can confirm it is hitting Railway
  console.log("NOWPAYMENTS WEBHOOK HIT:", JSON.stringify(body));

  // Try multiple possible fields (NOWPayments can vary by endpoint/version)
  const payment_id = String(body.payment_id ?? body.id ?? body.paymentId ?? "").trim();
  const payment_status = normalizeStatus(body.payment_status ?? body.status ?? body.paymentStatus);
  const email = String(body.email ?? body.buyer_email ?? "").trim();

  if (!payment_id) {
    return res.status(400).json({ ok: false, error: "Missing payment_id" });
  }

  // Treat both confirmed + finished as paid (NOWPayments often uses "finished")
  const paid = payment_status === "confirmed" || payment_status === "finished";

  // Upsert payment record
  const existing = payments.get(payment_id);
  const p = existing ?? {
    status: "unknown",
    token: null,
    expiresAt: null,
    email: email || null,
    updatedAt: null
  };

  p.status = payment_status || p.status;
  if (email) p.email = email;
  p.updatedAt = new Date().toISOString();

  // Generate token only once, when payment is paid
  if (paid && !p.token) {
    const token = makeToken();
    const expiresAt = addDays(new Date(), 30).toISOString();

    p.token = token;
    p.expiresAt = expiresAt;

   // tokens.set(token, {
   //   expiresAt,
   //   tiktokUsername: null,
   //   payment_id,
  //    createdAt: new Date().toISOString()
   // });

	await pool.query(
	  `INSERT INTO tokens (token, payment_id, tiktok_username, expires_at, used, created_at)
	   VALUES ($1, $2, NULL, $3, false, NOW())
	   ON CONFLICT (token) DO NOTHING`,
	  [token, payment_id, expiresAt]
	);

    console.log("TOKEN ISSUED:", { payment_id, token, expiresAt });
  }

  payments.set(payment_id, p);
  return res.json({ ok: true });
});

// ====== Claim page uses this: get token by payment_id ======


app.get("/token-by-payment/:paymentId", async (req, res) => {
  const paymentId = String(req.params.paymentId ?? "").trim();
  if (!paymentId) return res.status(400).json({ ok: false, error: "Missing paymentId" });

  try {
    // Find latest token for this payment_id
    const r = await pool.query(
      `SELECT token, expires_at, used
       FROM tokens
       WHERE payment_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [paymentId]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Token not found for this payment yet" });
    }

    const row = r.rows[0];

    // Railway UI created expires_at as "date" in your table, so handle both date/timestamp
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at);

    return res.json({
      ok: true,
      token: row.token,
      expiresAt,
      used: !!row.used
    });
  } catch (e) {
    console.error("token-by-payment error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== Game activates token with TikTok username ======
app.post("/activate", (req, res) => {
  const token = String(req.body?.token ?? "").trim().toUpperCase();
  const tiktokUsername = String(req.body?.tiktokUsername ?? "").trim();

  if (!token || !tiktokUsername) {
    return res.status(400).json({ ok: false, error: "token and tiktokUsername are required" });
  }

  const t = tokens.get(token);
  if (!t) return res.status(404).json({ ok: false, error: "Invalid token" });

  const now = new Date();
  const exp = new Date(t.expiresAt);
  if (now > exp) return res.json({ ok: false, error: "Expired", expiresAt: t.expiresAt });

  // Bind token to username on first activation; thereafter must match
  if (t.tiktokUsername && t.tiktokUsername.toLowerCase() !== tiktokUsername.toLowerCase()) {
    return res.status(403).json({ ok: false, error: "Token already bound to another username" });
  }

  t.tiktokUsername = tiktokUsername;
  tokens.set(token, t);

  return res.json({ ok: true, expiresAt: t.expiresAt });
});

// ====== Game checks token validity ======
app.post("/check", (req, res) => {
  const token = String(req.body?.token ?? "").trim().toUpperCase();
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
