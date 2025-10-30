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
  tls: process.env.MIKROTIK_SSL === 'true', // enables SSL (8729)
});

// ---------- MikroTik connection helper ----------
const mikrotikCfg = {
  host: process.env.MIKROTIK_HOST || "192.168.88.1",
  user: process.env.MIKROTIK_USER || "admin",
  password: process.env.MIKROTIK_PASS || "",
  port: parseInt(process.env.MIKROTIK_PORT || "8728", 10),
  timeout: parseInt(process.env.MIKROTIK_TIMEOUT || "20000", 10), // ms
};

let mikrotikApi = null; // RouterOSAPI instance
let mikrotikConn = null; // connection object

// attach router error handler (defensive)
function attachRouterErrorHandlers(api) {
  try {
    // Some versions provide connector and emit events
    if (api && api.connector && typeof api.connector.on === "function") {
      api.connector.on("error", (err) => {
        console.error("RouterOS connector error event:", err && err.message ? err.message : err);
        // try graceful cleanup
        try {
          if (mikrotikConn && typeof mikrotikConn.close === "function") mikrotikConn.close();
        } catch (e) {}
        mikrotikApi = null;
        mikrotikConn = null;
      });
    }
  } catch (e) {
    // non-fatal
  }
}

async function connectMikrotik() {
  try {
    if (mikrotikConn) return { api: mikrotikApi, conn: mikrotikConn };

    mikrotikApi = new RouterOSAPI({
      host: mikrotikCfg.host,
      user: mikrotikCfg.user,
      password: mikrotikCfg.password,
      port: mikrotikCfg.port,
      timeout: mikrotikCfg.timeout, // some builds accept this
    });

    attachRouterErrorHandlers(mikrotikApi);

    // connect() may throw on failure or timeout
    mikrotikConn = await mikrotikApi.connect();
    console.log("✅ Connected to MikroTik", mikrotikCfg.host);
    return { api: mikrotikApi, conn: mikrotikConn };
  } catch (err) {
    console.error("❌ MikroTik connect error:", err && err.message ? err.message : err);
    // clear so next attempt will retry
    try {
      if (mikrotikConn && typeof mikrotikConn.close === "function") mikrotikConn.close();
    } catch (e) {}
    mikrotikApi = null;
    mikrotikConn = null;
    throw err;
  }
}

async function disconnectMikrotik() {
  try {
    if (mikrotikConn && typeof mikrotikConn.close === "function") {
      mikrotikConn.close();
    }
  } catch (err) {
    // ignore
  } finally {
    mikrotikConn = null;
    mikrotikApi = null;
    console.log("ℹ️ MikroTik connection closed");
  }
}

// ---------- helpers ----------

/**
 * Convert Postgres interval or textual durations to RouterOS session-timeout strings.
 * e.g. "02:00:00" -> "2h", "1 day" -> "1d", "1 day 02:00:00" -> "1d2h", "00:30:00" -> "30m"
 * If cannot convert, returns null.
 */
function formatDurationForRouterOS(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  // days (e.g. "1 day" or "2 days")
  const dayMatch = s.match(/(\d+)\s*day/);
  // time HH:MM:SS
  const timeMatch = s.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  // textual hours/minutes e.g. "2 hours", "30 minutes"
  const hrText = s.match(/(\d+)\s*hour/);
  const minText = s.match(/(\d+)\s*min/);

  let out = "";

  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    if (!isNaN(days) && days > 0) out += `${days}d`;
  }

  if (timeMatch) {
    const hrs = parseInt(timeMatch[1], 10);
    const mins = parseInt(timeMatch[2], 10);
    const secs = parseInt(timeMatch[3], 10);

    if (!isNaN(hrs) && hrs > 0) out += `${hrs}h`;
    if (!isNaN(mins) && mins > 0) out += `${mins}m`;
    if (!isNaN(secs) && secs > 0 && out === "") out += `${secs}s`;
  }

  if (!out && hrText) out += `${parseInt(hrText[1], 10)}h`;
  if (!out && minText) out += `${parseInt(minText[1], 10)}m`;

  if (out && /^[0-9dhms]+$/.test(out)) return out;
  return null;
}

/**
 * helper to call conn.write and read result in a defensive way
 * supports driver variant that returns a stream with .read(),
 * or one that returns an array/object directly.
 * returns array of items or [] on none.
 */
async function routerPrint(conn, command, args = []) {
  try {
    const res = await conn.write(command, args);
    // if res has read()
    if (res && typeof res.read === "function") {
      const items = await res.read();
      return Array.isArray(items) ? items : (items ? [items] : []);
    }
    // some implementations return an array directly
    if (Array.isArray(res)) return res;
    if (res) return [res];
    return [];
  } catch (err) {
    // return empty and let caller handle absence
    // but log for visibility
    console.warn(`routerPrint warning for ${command}:`, err && err.message ? err.message : err);
    return [];
  }
}

// ---------- Utility: ensure hotspot user profile exists ----------
async function syncPlansToMikrotik() {
  try {
    const { conn } = await connectMikrotik();
    const plansRes = await pool.query(
      "SELECT id, price, duration, profile_name, rate_limit FROM plans WHERE active = true"
    );
    const plans = plansRes.rows;

    for (const plan of plans) {
      if (!plan.profile_name) {
        console.log(`Skipping plan id=${plan.id} because profile_name is empty`);
        continue;
      }

      // check existence
      let found = false;
      try {
        const items = await routerPrint(conn, "/ip/hotspot/user/profile/print", [`?name=${plan.profile_name}`]);
        if (items && items.length > 0) found = true;
      } catch (e) {
        console.warn(`Warning checking profile ${plan.profile_name}:`, e && e.message ? e.message : e);
      }

      if (found) {
        console.log(`Profile exists: ${plan.profile_name}`);
        continue;
      }

      // create profile
      try {
        const sessionTimeout = formatDurationForRouterOS(plan.duration);

        const addArgs = [`=name=${plan.profile_name}`];
        if (plan.rate_limit) addArgs.push(`=rate-limit=${plan.rate_limit}`);
        if (sessionTimeout) addArgs.push(`=session-timeout=${sessionTimeout}`);

        await conn.write("/ip/hotspot/user/profile/add", addArgs);
        console.log(`✅ Created profile ${plan.profile_name} (${plan.rate_limit || "no rate-limit"}, ${sessionTimeout || "no session-timeout"})`);
      } catch (err) {
        console.error(`Error creating profile ${plan.profile_name}:`, err && err.message ? err.message : err);
      }
    }
  } catch (err) {
    console.error("syncPlansToMikrotik failed:", err && err.message ? err.message : err);
    // don't throw — caller will retry later
  }
}

// ---------- Create hotspot user after successful payment ----------
async function createHotspotUser(phone, profileName) {
  try {
    const { conn } = await connectMikrotik();

    // remove existing user if present (ignore errors)
    try {
      await conn.write("/ip/hotspot/user/remove", [`?name=${phone}`]);
    } catch (e) {
      // ignore not found
    }

    const addArgs = [`=name=${phone}`, `=password=${phone}`];
    if (profileName) addArgs.push(`=profile=${profileName}`);

    await conn.write("/ip/hotspot/user/add", addArgs);
    console.log(`✅ Added hotspot user ${phone} with profile ${profileName || "(none)"}`);
  } catch (err) {
    console.error("createHotspotUser error:", err && err.message ? err.message : err);
    throw err;
  }
}

// ---------- API: get active plans ----------
app.get("/plans", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, price, EXTRACT(epoch FROM duration) AS seconds, profile_name, rate_limit, active FROM plans WHERE active=true ORDER BY price ASC"
    );

    const formatted = result.rows.map((p) => {
      let durationText = "";
      if (p.seconds) {
        const hrs = Math.floor(p.seconds / 3600);
        if (hrs >= 24 && hrs % 24 === 0) {
          const days = hrs / 24;
          durationText = days > 1 ? `${days} days` : `${days} day`;
        } else {
          durationText = `${hrs} hour${hrs > 1 ? "s" : ""}`;
        }
      }
      return {
        id: p.id,
        price: p.price,
        duration: durationText,
        profile_name: p.profile_name,
        rate_limit: p.rate_limit,
        active: p.active,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Error fetching plans:", err && err.message ? err.message : err);
    res.status(500).send("Server error");
  }
});

// ---------- Payment (STK push) endpoint ----------
app.post("/pay", async (req, res) => {
  try {
    const { phone, plan_id } = req.body;
    if (!phone || !/^254\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, error: "Invalid phone number" });
    }

    const planRes = await pool.query("SELECT id, price, profile_name FROM plans WHERE id=$1 AND active=true", [plan_id]);
    if (planRes.rows.length === 0) return res.status(400).json({ success: false, error: "Invalid plan" });
    const plan = planRes.rows[0];
    const amount = plan.price;

    // create transaction
    const txRes = await pool.query("INSERT INTO transactions (phone_number, amount, status) VALUES ($1,$2,$3) RETURNING id", [phone, amount, "pending"]);
    const txId = txRes.rows[0].id;

    // get access token (sandbox or production)
    const baseUrl = process.env.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");
    const tokenRes = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
    const token = tokenRes.data.access_token;

    // build STK push password
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const password = Buffer.from(process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp).toString("base64");

    const stkPayload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
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

// ---------- Callback endpoint ----------
app.post("/callback", async (req, res) => {
  try {
    const callbackData = req.body;
    console.log("📩 M-Pesa callback:", JSON.stringify(callbackData, null, 2));

    const checkoutId = callbackData?.Body?.stkCallback?.CheckoutRequestID;
    const resultCode = callbackData?.Body?.stkCallback?.ResultCode;

    if (!checkoutId) {
      return res.status(400).send("Invalid callback");
    }

    const tx = await pool.query("SELECT id, phone_number FROM transactions WHERE mpesa_request_id=$1", [checkoutId]);
    if (tx.rows.length === 0) {
      console.warn("Transaction not found for", checkoutId);
      return res.json({ message: "Transaction not found" });
    }
    const txId = tx.rows[0].id;
    const phone = tx.rows[0].phone_number;

    if (resultCode === 0) {
      const metadata = callbackData.Body.stkCallback.CallbackMetadata;
      const amountItem = metadata.Item.find(i => i.Name === "Amount");
      const receiptItem = metadata.Item.find(i => i.Name === "MpesaReceiptNumber");
      const phoneItem = metadata.Item.find(i => i.Name === "PhoneNumber");

      const amount = amountItem ? amountItem.Value : null;
      const receipt = receiptItem ? receiptItem.Value : null;
      const paidPhone = phoneItem ? phoneItem.Value : phone;

      await pool.query("UPDATE transactions SET status=$1, mpesa_receipt=$2 WHERE id=$3", ["success", receipt, txId]);

      // find plan by amount (use first matching active plan)
      const planRes = await pool.query("SELECT id, profile_name FROM plans WHERE price=$1 AND active=true ORDER BY id LIMIT 1", [amount]);
      if (planRes.rows.length === 0) {
        console.warn("No plan found for amount", amount);
      } else {
        const profileName = planRes.rows[0].profile_name;

        // ensure user exists in users table
        const u = await pool.query("SELECT id FROM users WHERE phone_number=$1", [paidPhone]);
        if (u.rows.length === 0) {
          await pool.query("INSERT INTO users (username, password, phone_number) VALUES ($1,$2,$3)", [paidPhone, paidPhone, paidPhone]);
        }

        // extend active_until by plan duration
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

        // create MikroTik user for immediate login (best-effort)
        try {
          await createHotspotUser(paidPhone, profileName);
        } catch (err) {
          console.error("Failed to create mikrotik user:", err && err.message ? err.message : err);
        }
      }
    } else {
      await pool.query("UPDATE transactions SET status=$1 WHERE id=$2", ["failed", txId]);
      console.log("Payment failed:", callbackData.Body.stkCallback.ResultDesc);
    }

    res.json({ message: "Callback processed" });
  } catch (err) {
    console.error("callback handler error:", err && err.message ? err.message : err);
    res.status(500).send("Server error");
  }
});

// ---------- Validate user endpoint ----------
app.get("/validate-user/:phone", async (req, res) => {
  try {
    const phone = req.params.phone;
    const result = await pool.query("SELECT active_until FROM users WHERE phone_number=$1", [phone]);
    if (result.rows.length === 0) return res.json({ phone, active: false, active_until: null });
    const activeUntil = result.rows[0].active_until;
    const isActive = activeUntil && new Date(activeUntil) > new Date();
    res.json({ phone, active: isActive, active_until: activeUntil });
  } catch (err) {
    console.error("validate-user error:", err && err.message ? err.message : err);
    res.status(500).json({ phone: req.params.phone, active: false });
  }
});

// ---------- Start server and run initial MikroTik sync ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  try {
    await connectMikrotik();
    await syncPlansToMikrotik();
    setInterval(syncPlansToMikrotik, 10 * 60 * 1000); // every 10 minutes
  } catch (err) {
    console.warn("MikroTik initial sync failed - will retry later:", err && err.message ? err.message : err);
  }
});

