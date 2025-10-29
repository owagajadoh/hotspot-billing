// 🌍 Change this to your actual server (LAN IP or domain)
const SERVER_IP = "http://localhost:5000";  

// Ensure phone input always starts with 254
function formatPhoneInput() {
  let phoneInput = document.getElementById("phone");
  if (!phoneInput.value.startsWith("254")) {
    phoneInput.value = "254";
  }
}

// Auto validate user when phone is typed
async function autoValidateUser() {
  const phone = document.getElementById("phone").value;
  if (phone.length < 12) return; // Minimum valid length (2547XXXXXXXX)

  try {
    const res = await fetch(`${SERVER_IP}/validate-user/${phone}`);
    const data = await res.json();

    if (data.active) {
      alert("✅ You are already connected!");
      reconnectUser(); // Auto reconnect if still active
    }
  } catch (err) {
    console.error("Validation error:", err);
  }
}

// Show spinner
function showSpinner() {
  document.getElementById("loadingSpinner").style.display = "flex";
}

// Hide spinner
function hideSpinner() {
  document.getElementById("loadingSpinner").style.display = "none";
}

// ✅ Buy plan (uses planId)
async function buyPlan(planId) {
  const phone = document.getElementById("phone").value;

  if (!phone || !phone.startsWith("254")) {
    alert("⚠️ Please enter a valid phone number starting with 254.");
    return;
  }

  showSpinner();

  try {
    const res = await fetch(`${SERVER_IP}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, plan_id: planId })
    });

    const data = await res.json();
    if (data.success) {
      alert("📲 Payment request sent! Check your phone.");
    } else {
      alert("❌ Failed: " + data.error);
    }
  } catch (err) {
    console.error("Buy plan error:", err);
    alert("⚠️ Error connecting to server.");
  } finally {
    hideSpinner();
  }
}

// ✅ Reconnect user
async function reconnectUser() {
  const phone = document.getElementById("phone").value;
  if (!phone || !phone.startsWith("254")) {
    alert("⚠️ Please enter a valid phone number starting with 254.");
    return;
  }

  showSpinner();

  try {
    const res = await fetch(`${SERVER_IP}/validate-user/${phone}`);
    const data = await res.json();

    if (data.active) {
      // ✅ User still has time → log them back into MikroTik
      window.location.href = `http://192.168.88.1/login?username=${phone}&password=${phone}`;
    } else {
      alert("⚠️ Your session expired. Please buy a new plan.");
    }
  } catch (err) {
    console.error("Reconnect error:", err);
    alert("⚠️ Could not reconnect. Try again later.");
  } finally {
    hideSpinner();
  }
}

// ✅ Fetch plans dynamically from backend
async function loadPlans() {
  try {
    const res = await fetch(`${SERVER_IP}/plans`);
    const plans = await res.json();

    const container = document.querySelector(".plans");
    container.innerHTML = ""; // Clear loading text

    plans.forEach(plan => {
      const card = document.createElement("div");
      card.className = "plan-card";

      card.innerHTML = `
        <h3>Ksh ${plan.price}</h3>
        <p>Unlimited Internet</p>
        <span class="duration">${plan.duration}</span>
        <button onclick="buyPlan(${plan.id})">Buy Now</button>
      `;

      container.appendChild(card);
    });
  } catch (err) {
    console.error("Error loading plans:", err);
    document.querySelector(".plans").innerHTML =
      "<p>⚠️ Failed to load plans. Try again later.</p>";
  }
}

// ✅ Run when page loads
document.addEventListener("DOMContentLoaded", loadPlans);
