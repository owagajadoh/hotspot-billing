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

// ---------- MikroTik connection helper ----------
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

function attachRouterErrorHandlers(api) {
  try {
    if (!api) return;
    const connector = api.connector || api;
    if (connector && typeof connector.on === "function") {
      connector.on("error", (err) => {
        console.error("RouterOS connector error event:", err?.message || err);
        try { if (mikrotikConn?.close) mikrotikConn.close(); } catch(e) {}
        mikrotikApi = null;
        mikrotikConn = null;
      });
      connector.on("timeout", (err) => {
        console.warn("RouterOS connector timeout event:", err?.message || err);
      });
    }
  } catch (e) {}
}

async function connectMikrotik() {
  try {
    if (mikrotikConn) return { api: mikrotikApi, conn: mikrotikConn };

    const options = {
      host: mikrotikCfg.host,
      user: mikrotikCfg.user,
      password: mikrotikCfg.password,
      port: mikrotikCfg.port,
      timeout: mikrotikCfg.timeout,
    };

    if (mikrotikCfg.useSsl || mikrotikCfg.port === 8729) {
      options.tls = true;
      options.rejectUnauthorized = mikrotikCfg.rejectUnauthorized === true;
    }

    mikrotikApi = new RouterOSAPI(options);
    attachRouterErrorHandlers(mikrotikApi);

    mikrotikConn = await mikrotikApi.connect();
    console.log("✅ Connected to MikroTik", mikrotikCfg.host);
    return { api: mikrotikApi, conn: mikrotikConn };
  } catch (err) {
    console.error("❌ MikroTik connect error:", err?.message || err);
    try { if (mikrotikConn?.close) mikrotikConn.close(); } catch(e) {}
    mikrotikApi = null;
    mikrotikConn = null;
    throw err;
  }
}

async function disconnectMikrotik() {
  try { if (mikrotikConn?.close) mikrotikConn.close(); } catch {}
  mikrotikConn = null;
  mikrotikApi = null;
  console.log("ℹ️ MikroTik connection closed");
}

// ---------- helpers ----------
function formatDurationForRouterOS(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const dayMatch = s.match(/(\d+)\s*day/);
  const timeMatch = s.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  const hrText = s.match(/(\d+)\s*hour/);
  const minText = s.match(/(\d+)\s*min/);

  let out = "";
  if (dayMatch) out += `${parseInt(dayMatch[1], 10)}d`;
  if (timeMatch) out += `${parseInt(timeMatch[1], 10)}h${parseInt(timeMatch[2], 10)}m`;
  if (!out && hrText) out += `${parseInt(hrText[1], 10)}h`;
  if (!out && minText) out += `${parseInt(minText[1], 10)}m`;
  return /^[0-9dhms]+$/.test(out) ? out : null;
}

async function routerPrint(conn, command, args = []) {
  try {
    const res = await conn.write(command, args);
    if (res?.read) return Array.isArray(await res.read()) ? await res.read() : [await res.read()];
    return Array.isArray(res) ? res : res ? [res] : [];
  } catch (err) {
    console.warn(`routerPrint warning for ${command}:`, err?.message || err);
    return [];
  }
}

async function syncPlansToMikrotik() {
  try {
    const { conn } = await connectMikrotik();
    const plansRes = await pool.query(
      "SELECT id, price, duration, profile_name, rate_limit FROM plans WHERE active = true"
    );
    const plans = plansRes.rows;

    for (const plan of plans) {
      if (!plan.profile_name) continue;
      let found = false;
      try {
        const items = await routerPrint(conn, "/ip/hotspot/user/profile/print", [`?name=${plan.profile_name}`]);
        if (items.length > 0) found = true;
      } catch {}

      if (!found) {
        try {
          const sessionTimeout = formatDurationForRouterOS(plan.duration);
          const addArgs = [`=name=${plan.profile_name}`];
          if (plan.rate_limit) addArgs.push(`=rate-limit=${plan.rate_limit}`);
          if (sessionTimeout) addArgs.push(`=session-timeout=${sessionTimeout}`);
          await conn.write("/ip/hotspot/user/profile/add", addArgs);
          console.log(`✅ Created profile ${plan.profile_name}`);
        } catch (err) {
          console.error(`Error creating profile ${plan.profile_name}:`, err?.message || err);
        }
      }
    }
  } catch (err) {
    console.error("syncPlansToMikrotik failed:", err?.message || err);
  }
}

async function createHotspotUser(phone, profileName) {
  try {
    const { conn } = await connectMikrotik();
    try { await conn.write("/ip/hotspot/user/remove", [`?name=${phone}`]); } catch {}
    const addArgs = [`=name=${phone}`, `=password=${phone}`];
    if (profileName) addArgs.push(`=profile=${profileName}`);
    await conn.write("/ip/hotspot/user/add", addArgs);
    console.log(`✅ Added hotspot user ${phone} with profile ${profileName || "(none)"}`);
  } catch (err) {
    console.error("createHotspotUser error:", err?.message || err);
    throw err;
  }
}

// ---------- API endpoints ----------
// /plans
app.get("/plans", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, price, EXTRACT(epoch FROM duration) AS seconds, profile_name, rate_limit, active FROM plans WHERE active=true ORDER BY price ASC"
    );
    const formatted = result.rows.map(p => {
      let durationText = "";
      if (p.seconds) {
        const hrs = Math.floor(p.seconds / 3600);
        durationText = hrs >= 24 && hrs % 24 === 0 ? `${hrs / 24} day(s)` : `${hrs} hour(s)`;
      }
      return { id: p.id, price: p.price, duration: durationText, profile_name: p.profile_name, rate_limit: p.rate_limit, active: p.active };
    });
    res.json(formatted);
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

    const planRes = await pool.query("SELECT id, price, profile_name FROM plans WHERE id=$1 AND active=true", [plan_id]);
    if (planRes.rows.length === 0) return res.status(400).json({ success: false, error: "Invalid plan" });
    const plan = planRes.rows[0];

    const txRes = await pool.query("INSERT INTO transactions (phone_number, amount, status) VALUES ($1,$2,$3) RETURNING id", [phone, plan.price, "pending"]);
    const txId = txRes.rows[0].id;

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
    console.error("pay error:", err.response?.data || err.message || err);
    res.status(500).json({ success: false, error: "Payment initiation failed" });
  }
});

// /callback
app.post("/callback", async (req, res) => {
  try {
    const callbackData = req.body;
    console.log("📩 M-Pesa callback:", JSON.stringify(callbackData, null, 2));

    const checkoutId = callbackData?.Body?.stkCallback?.CheckoutRequestID;
    const resultCode = callbackData?.Body?.stkCallback?.ResultCode;
    if (!checkoutId) return res.status(400).send("Invalid callback");

    const tx = await pool.query("SELECT id, phone_number FROM transactions WHERE mpesa_request_id=$1", [checkoutId]);
    if (tx.rows.length === 0) return res.json({ message: "Transaction not found" });

    const txId = tx.rows[0].id;
    const phone = tx.rows[0].phone_number;

    if (resultCode === 0) {
      const metadata = callbackData.Body.stkCallback.CallbackMetadata;
      const amountItem = metadata.Item.find(i => i.Name === "Amount");
      const receiptItem = metadata.Item.find(i => i.Name === "MpesaReceiptNumber");
      const phoneItem = metadata.Item.find(i => i.Name === "PhoneNumber");
      const amount = amountItem?.Value;
      const receipt = receiptItem?.Value;
      const paidPhone = phoneItem?.Value || phone;

      await pool.query("UPDATE transactions SET status=$1, mpesa_receipt=$2 WHERE id=$3", ["success", receipt, txId]);

      const planRes = await pool.query("SELECT profile_name FROM plans WHERE price=$1 AND active=true ORDER BY id LIMIT 1", [amount]);
      if (planRes.rows.length > 0) {
        const profileName = planRes.rows[0].profile_name;
        const u = await pool.query("SELECT id FROM users WHERE phone_number=$1", [paidPhone]);
        if (u.rows.length === 0) await pool.query("INSERT INTO users (username, password, phone_number) VALUES ($1,$2,$3)", [paidPhone, paidPhone, paidPhone]);

        await pool.query(
          `UPDATE users
           SET active_until = CASE
             WHEN active_until IS NULL OR active_until < NOW()
               THEN NOW() + (SELECT duration FROM plans WHERE price=$1 LIMIT 1)
             ELSE active_until + (SELECT duration FROM plans WHERE price=$1 LIMIT 1)
           END
           WHERE phone_number = $2`,
          [amount, paidPhone]
        );

        try { await createHotspotUser(paidPhone, profileName); } catch (err) { console.error("Failed to create mikrotik user:", err?.message || err); }
      }
    } else {
      await pool.query("UPDATE transactions SET status=$1 WHERE id=$2", ["failed", txId]);
      console.log("Payment failed:", callbackData.Body.stkCallback.ResultDesc);
    }

    res.json({ message: "Callback processed" });
  } catch (err) {
    console.error("callback handler error:", err?.message || err);
    res.status(500).send("Server error");
  }
});

// /validate-user
app.get("/validate-user/:phone", async (req, res) => {
  try {
    const phone = req.params.phone;
    const result = await pool.query("SELECT active_until FROM users WHERE phone_number=$1", [phone]);
    if (result.rows.length === 0) return res.json({ phone, active: false, active_until: null });
    const activeUntil = result.rows[0].active_until;
    const isActive = activeUntil && new Date(activeUntil) > new Date();
    res.json({ phone, active: isActive, active_until: activeUntil });
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
    await syncPlansToMikrotik();
    setInterval(syncPlansToMikrotik, 10 * 60 * 1000);
  } catch (err) {
    console.warn("MikroTik initial sync failed - will retry later:", err?.message || err);
  }
});
