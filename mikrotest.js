import { RouterOSAPI } from "node-routeros";
import dotenv from "dotenv";
dotenv.config();

const conn = new RouterOSAPI({
  host: process.env.MIKROTIK_HOST,
  user: process.env.MIKROTIK_USER,
  password: process.env.MIKROTIK_PASS,
  port: process.env.MIKROTIK_PORT,
  ssl: process.env.MIKROTIK_SSL === "true",
  timeout: 30,
});

conn.connect()
  .then(() => console.log("✅ Connected successfully"))
  .catch(err => console.error("❌ Connection failed:", err));
