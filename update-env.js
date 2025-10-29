// update-env.js
const fs = require("fs");
const axios = require("axios");
const path = require("path");

async function updateEnv() {
  try {
    const res = await axios.get("http://127.0.0.1:4040/api/tunnels");
    const tunnels = res.data.tunnels;

    const httpsTunnel = tunnels.find(t => t.proto === "https");
    if (!httpsTunnel) throw new Error("No HTTPS tunnel found. Run `ngrok http 5000` first.");

    const newUrl = httpsTunnel.public_url;
    console.log("✅ Ngrok URL found:", newUrl);

    const envPath = path.join(__dirname, ".env");
    let envData = fs.readFileSync(envPath, "utf8");

    if (envData.includes("CALLBACK_URL=")) {
      envData = envData.replace(/CALLBACK_URL=.*/g, `CALLBACK_URL=${newUrl}/callback`);
    } else {
      envData += `\nCALLBACK_URL=${newUrl}/callback\n`;
    }

    fs.writeFileSync(envPath, envData, "utf8");
    console.log("✅ .env updated successfully!");
  } catch (err) {
    console.error("❌ Failed to update .env:", err.message);
  }
}

updateEnv();
