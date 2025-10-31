// server.js - Hotspot billing + M-Pesa + MikroTik sync & user creation
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const { RouterOSAPI } = require("node-routeros");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Postgres ----------
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "hotspot",
  password: process.env.DB_PASS || "",
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  ssl: process.env.DB_SSL === "true"
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" }
    : false,
});

// ---------- MikroTik ----------
const mikrotikCfg = {
  host: process.env.MIKROTIK_HOST || "192.168.88.1",
  user: process.env.MIKROTIK_USER || "admin",
  password: process.env.MIKROTIK_PASS || "",
  port: process.env.MIKROTIK_PORT ? parseInt(process.env.MIKROTIK_PORT, 10) : undefined,
  timeout: process.env.MIKROTIK_TIMEOUT ? parseInt(process.env.MIKROTIK_TIMEOUT, 10) : 20000,
  useSsl: process.env.MIKROTIK_SSL === "true",
  rejectUnauthorized: process.env.MIKROTIK_REJECT_UNAUTHORIZED !== "false",
};

if (!mikrotikCfg.port) mikrotikCfg.port = mikrotikCfg.useSsl ? 8729 : 8728;

let mikrotikApi = null;
let mikrotikConn = null;

async function connectMikrotik() {
  try {
    if (mikrotikConn) return mikrotikConn;
    mikrotikApi = new RouterOSAPI({
      host: mikrotikCfg.host,
      user: mikrotikCfg.user,
      password: mikrotikCfg.password,
      port: mikrotikCfg.port,
      timeout: mikrotikCfg.timeout,
      tls: mikrotikCfg.useSsl,
      rejectUnauthorized: mikrotikCfg.rejectUnauthorized === true,
    });
    mikrotikConn = await mikrotikApi.connect();
    console.log("✅ Connected to MikroTik", mikrotikCfg.host);
    return mikrotikConn;
  } catch (err) {
    console.error("❌ MikroTik connect error:", err?.message || err);
    mikrotikConn = null;
    mikrotikApi = null;
    throw err;
  }
}

// ---------- Hotspot user helper ----------
async function createOrUpdateHotspotUser(phone, profileName) {
  try {
    const conn = await connectMikrotik();
    // remove if exists
    try { await conn.write("/ip/hotspot/user/remove", [`?name=${phone}`]); } catch {}
    // add user with profile
    await conn.write("/ip/hotspot/user/add", [`=name=${phone}`, `=password=${phone}`, `=profile=${profileName}`]);
    console.log(`✅ MikroTik user ${phone} assigned to profile ${profileName}`);
  } catch (err) {
    console.error("Hotspot user creation failed:", err?.message || err);
  }
}

// ---------- API endpoints ----------
// /plans
app.get("/plans", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, price, profile_name, duration FROM plans WHERE active=true ORDER BY price ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching plans:", err?.message || err);
    res.status(500).send("Server error");
  }
});

// /pay
app.post("/pay", async (req, res) => {
  try {
    const { phone, plan_id } = req.body;
    if (!phone || !/^254\d{9}$/.test(phone)) return res.status(400).json({ success: false, error: "Invalid phone number" });

    const planRes = await pool.query("SELECT id, price, profile_name, duration FROM plans WHERE id=$1 AND active=true", [plan_id]);
    if (!planRes.rows.length) return res.status(400).json({ success: false, error: "Invalid plan" });
    const plan = planRes.rows[0];

    // Create transaction
    const txRes = await pool.query("INSERT INTO transactions (phone_number, amount, status) VALUES ($1,$2,$3) RETURNING id", [phone, plan.price, "pending"]);
    const txId = txRes.rows[0].id;

    // Initiate M-Pesa STK Push
    const baseUrl = process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");
    const tokenRes = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
    const token = tokenRes.data.access_token;

    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const password = Buffer.from(process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp).toString("base64");

    const stkPayload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: plan.price,
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: "ClanWiFi",
      TransactionDesc: "WiFi Purchase",
    };

    const stkRes = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, stkPayload, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const checkoutId = stkRes.data.CheckoutRequestID;
    await pool.query("UPDATE transactions SET mpesa_request_id=$1 WHERE id=$2", [checkoutId, txId]);

    res.json({ success: true, checkoutId });
  } catch (err) {
    console.error("Payment initiation failed:", err.response?.data || err.message || err);
    res.status(500).json({ success: false, error: "Payment initiation failed" });
  }
});

// /callback
app.post("/callback", async (req, res) => {
  try {
    const cb = req.body;
    const checkoutId = cb?.Body?.stkCallback?.CheckoutRequestID;
    const resultCode = cb?.Body?.stkCallback?.ResultCode;
    if (!checkoutId) return res.status(400).send("Invalid callback");

    const tx = await pool.query("SELECT id, phone_number FROM transactions WHERE mpesa_request_id=$1", [checkoutId]);
    if (!tx.rows.length) return res.json({ message: "Transaction not found" });

    const txId = tx.rows[0].id;
    const phone = tx.rows[0].phone_number;

    if (resultCode === 0) {
      const metadata = cb.Body.stkCallback.CallbackMetadata;
      const amount = metadata.Item.find(i => i.Name === "Amount")?.Value;

      await pool.query("UPDATE transactions SET status=$1 WHERE id=$2", ["success", txId]);

      // Upsert user
      const planRes = await pool.query("SELECT profile_name, duration FROM plans WHERE price=$1 LIMIT 1", [amount]);
      if (!planRes.rows.length) return res.json({ message: "Plan not found" });
      const { profile_name, duration } = planRes.rows[0];

      await pool.query(
        `INSERT INTO users (phone_number, username, password, plan_profile, active_until)
         VALUES ($1,$2,$3,$4,NOW() + $5::interval)
         ON CONFLICT (phone_number) DO UPDATE
         SET plan_profile = EXCLUDED.plan_profile,
             active_until = CASE
               WHEN users.active_until < NOW() THEN NOW() + $5::interval
               ELSE users.active_until + $5::interval
             END`,
        [phone, phone, phone, profile_name, duration]
      );

      // Update MikroTik
      await createOrUpdateHotspotUser(phone, profile_name);

    } else {
      await pool.query("UPDATE transactions SET status=$1 WHERE id=$2", ["failed", txId]);
      console.log("Payment failed:", cb.Body.stkCallback.ResultDesc);
    }

    res.json({ message: "Callback processed" });
  } catch (err) {
    console.error("Callback processing failed:", err?.message || err);
    res.status(500).send("Server error");
  }
});

// /validate-user
app.get("/validate-user/:phone", async (req, res) => {
  try {
    const phone = req.params.phone;
    const u = await pool.query("SELECT active_until FROM users WHERE phone_number=$1", [phone]);
    if (!u.rows.length) return res.json({ phone, active: false, active_until: null });
    const isActive = u.rows[0].active_until > new Date();
    res.json({ phone, active: isActive, active_until: u.rows[0].active_until });
  } catch (err) {
    console.error("validate-user error:", err?.message || err);
    res.status(500).json({ phone: req.params.phone, active: false });
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  try {
    await connectMikrotik();
  } catch (err) {
    console.warn("MikroTik connection failed - will retry on demand:", err?.message || err);
  }
});
