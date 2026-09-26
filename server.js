require("dotenv").config();

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { createReportPdf, getOrders, saveOrder, updateOrderStatus } = require("./reports"); // ➕ ADDED updateOrderStatus

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,

  LAPAZ_BRANCH_NUMBER,

  STORE_NAME = "Sweet Bite"
} = process.env;

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v23.0";

const WA_URL =
  `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

/*--------------------------------------------------------------------------
 ➕ ADDED: LOGGING — every line is timestamped and tagged so you can follow
 what the bot is doing in the console (or your hosting provider's log tab).
--------------------------------------------------------------------------*/
function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}
function log(tag, ...args) {
  console.log(`[${ts()}] ${tag}`, ...args);
}
function logError(tag, error) {
  const detail = error?.response?.data ? JSON.stringify(error.response.data) : (error?.message || error);
  console.error(`[${ts()}] ${tag} ❌`, detail);
}

// ➕ ADDED: if the process is about to crash or die, say so loudly BEFORE it goes down.
// Without this, a crash mid-message looks identical to "the bot silently ignored this person" —
// the log simply stops with no explanation, which is exactly what you were seeing.
process.on("uncaughtException", (error) => {
  logError("[crash] uncaughtException — process will exit", error);
});
process.on("unhandledRejection", (reason) => {
  logError("[crash] unhandledRejection (a promise failed with no .catch)", reason);
});
process.on("SIGTERM", () => log("[boot]", "Received SIGTERM — host is stopping/restarting this process"));
process.on("SIGINT",  () => log("[boot]", "Received SIGINT — process stopping"));

/*--------------------------------------------------------------------------
 BRANCH — only one branch, LAPAZ
--------------------------------------------------------------------------*/
const BRANCH_NAME = "Lapaz";
const BRANCH_NUMBER = LAPAZ_BRANCH_NUMBER;

/*--------------------------------------------------------------------------
 MENU — Jollof Rice & Fried Rice only, prices ₵30 - ₵50 (includes free chicken)
--------------------------------------------------------------------------*/
const RICE_PORTIONS = [
  { amount: 30, chicken: 1 },
  { amount: 35, chicken: 1 },
  { amount: 40, chicken: 2 },
  { amount: 45, chicken: 2 },
  { amount: 50, chicken: 2 }
];

const FOODS = {
  food_jollof: "Jollof Rice",
  food_fried:  "Fried Rice"
};

/*--------------------------------------------------------------------------
 SESSIONS AND ORDERS
--------------------------------------------------------------------------*/
const sessions = new Map();
const orders   = new Map();

/*--------------------------------------------------------------------------
 HELPERS
--------------------------------------------------------------------------*/
function normalizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("233")) return phone;
  if (phone.startsWith("0")) return "233" + phone.substring(1);
  return phone;
}

function money(amount) {
  return `₵${Number(amount).toFixed(2)}`;
}

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      step: "WELCOME",
      food: null,
      foodAmount: null,
      includedChicken: 0,
      fulfillment: null,
      address: null,
      order: null
    });
  }
  return sessions.get(phone);
}

function resetSession(phone) {
  sessions.set(phone, {
    step: "WELCOME",
    food: null,
    foodAmount: null,
    includedChicken: 0,
    fulfillment: null,
    address: null,
    order: null
  });
}

function isBranchPhone(phone) {
  if (!BRANCH_NUMBER) return false;
  return normalizePhone(phone) === normalizePhone(BRANCH_NUMBER);
}

/*--------------------------------------------------------------------------
 WHATSAPP TEXT
--------------------------------------------------------------------------*/
async function sendWhatsAppText(to, body) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body }
  };
  log("[send:text]", `-> ${to} :: ${String(body).replace(/\n/g, " | ").slice(0, 120)}`); // ➕ ADDED
  try {
    return await axios.post(WA_URL, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    // ➕ ADDED: Meta error 131030 means this WhatsApp app is still in "Development" mode,
    // which only allows sending to a short list of pre-approved test numbers. Receiving
    // still works either way, which is exactly why a brand-new customer's message shows
    // up in the logs but never gets a reply. Fix: Meta dashboard -> WhatsApp -> API Setup
    // -> add the number as a tester, or switch the app to Live mode (needs Business Verification).
    if (error?.response?.data?.error?.code === 131030) {
      logError(`[send:text] to ${to} — RECIPIENT NOT ALLOWED (app is in Development mode; add ${to} as a test number in Meta's WhatsApp API Setup, or go Live)`, error);
    } else {
      logError(`[send:text] to ${to}`, error);
    }
    throw error;
  }
}

async function sendWhatsAppDocument(to, pdfBuffer, filename, caption) {
  log("[send:doc]", `-> ${to} :: ${filename} (${pdfBuffer.length} bytes)`); // ➕ ADDED
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", pdfBuffer, { filename, contentType: "application/pdf" });

    const upload = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`,
      form,
      { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, ...form.getHeaders() } }
    );

    return await axios.post(WA_URL, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: { id: upload.data.id, filename, caption }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    logError(`[send:doc] to ${to}`, error); // ➕ ADDED
    throw error;
  }
}

/*--------------------------------------------------------------------------
 WHATSAPP BUTTONS
--------------------------------------------------------------------------*/
async function sendButtons(to, body, buttons) {
  log("[send:buttons]", `-> ${to} :: [${buttons.map(b => b.title).join(", ")}]`); // ➕ ADDED
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map(button => ({
          type: "reply",
          reply: { id: button.id, title: button.title.substring(0, 20) }
        }))
      }
    }
  };
  try {
    return await axios.post(WA_URL, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    logError(`[send:buttons] to ${to}`, error); // ➕ ADDED
    throw error;
  }
}

/*--------------------------------------------------------------------------
 WHATSAPP LIST
--------------------------------------------------------------------------*/
async function sendInteractiveList(to, body, section, rows, buttonText = "Select") {
  log("[send:list]", `-> ${to} :: ${section} [${rows.map(r => r.title).join(", ")}]`); // ➕ ADDED
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: buttonText.substring(0, 20),
        sections: [
          {
            title: section.substring(0, 24),
            rows: rows.slice(0, 10).map(row => ({
              id: row.id,
              title: row.title.substring(0, 24),
              description: row.description ? row.description.substring(0, 72) : undefined
            }))
          }
        ]
      }
    }
  };
  try {
    return await axios.post(WA_URL, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    logError(`[send:list] to ${to}`, error); // ➕ ADDED
    throw error;
  }
}

/*--------------------------------------------------------------------------
 MENU ROWS
--------------------------------------------------------------------------*/
function foodRows() {
  return [
    { id: "food_jollof", title: "Jollof Rice", description: "₵30 - ₵50" },
    { id: "food_fried",  title: "Fried Rice",  description: "₵30 - ₵50" }
  ];
}

function priceRows() {
  return RICE_PORTIONS.map(portion => ({
    id: `price_${portion.amount}`,
    title: money(portion.amount),
    description: `Includes ${portion.chicken} chicken`
  }));
}

/*--------------------------------------------------------------------------
 CALCULATE TOTAL
--------------------------------------------------------------------------*/
function calculateTotal(session) {
  return Number(session.foodAmount) || 0;
}

/*--------------------------------------------------------------------------
 ORDER ID
--------------------------------------------------------------------------*/
function generateOrderId() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return `SB-${day}${month}${hour}${minutes}`;
}

/*--------------------------------------------------------------------------
 ORDER SUMMARY
--------------------------------------------------------------------------*/
function buildOrderSummary(session) {
  const chickenLine = session.includedChicken ? `🍗 Includes ${session.includedChicken} chicken\n` : "";
  return `🛍️ *${STORE_NAME.toUpperCase()} ORDER*

📍 Location: ${BRANCH_NAME}
🍽️ Food: ${session.food}
${chickenLine}💵 *TOTAL: ${money(calculateTotal(session))}*
🚚 Method: ${session.fulfillment === "pickup" ? "Pick Up" : "Delivery — Pay on Delivery"}${session.fulfillment === "delivery" ? `\n📍 Address:\n${session.address}` : ""}`;
}

/*--------------------------------------------------------------------------
 FULFILLMENT OPTIONS
--------------------------------------------------------------------------*/
async function showFulfillmentOptions(to) {
  return sendInteractiveList(to,
    "🚚 How would you like to receive your food?",
    "Order Method",
    [
      { id: "pickup",   title: "Pick Up",  description: "Come to our Lapaz location" },
      { id: "delivery", title: "Delivery", description: "Pay the rider on delivery" }
    ]
  );
}

/*--------------------------------------------------------------------------
 CUSTOMER CONFIRMATION
--------------------------------------------------------------------------*/
async function sendOrderConfirmation(to, session) {
  const total = calculateTotal(session);
  await sendWhatsAppText(to,
    `🧾 *PLEASE CONFIRM YOUR ORDER*\n${buildOrderSummary(session)}\n━━━━━━━━━━━━━━\n\nIs everything correct?`
  );
  return sendButtons(to,
    `Total: ${money(total)}\n\nWould you like to place this order?`,
    [
      { id: "confirm_order", title: "✅ Place Order" },
      { id: "cancel_order",  title: "❌ Cancel"      }
    ]
  );
}

/*--------------------------------------------------------------------------
 SEND ORDER TO BRANCH
--------------------------------------------------------------------------*/
async function sendOrderToBranch(order) {
  if (!BRANCH_NUMBER) {
    logError("[order:branch]", `No WhatsApp number configured for the ${BRANCH_NAME} branch (set LAPAZ_BRANCH_NUMBER)`); // ➕ CHANGED
    return false;
  }
  log("[order:branch]", `Notifying ${BRANCH_NAME} (+${normalizePhone(BRANCH_NUMBER)}) about order ${order.id}`); // ➕ ADDED

  const chickenLine = order.includedChicken ? `🍗 Includes ${order.includedChicken} chicken\n` : "";

  const message = `🔔 *NEW ORDER*

🆔 Order: ${order.id}
📍 Branch: ${order.branch}
📱 Customer: ${order.customerPhone}
🍽️ Food: ${order.food}
${chickenLine}━━━━━━━━━━━━━

💵 *TOTAL: ${money(order.total)}*
🚚 Method: ${order.fulfillment === "pickup" ? "PICK UP" : "DELIVERY — PAY ON DELIVERY"}${order.fulfillment === "delivery" ? `\n📍 DELIVERY ADDRESS:\n${order.address}` : ""}
━━━━━━━━━━━━━━

Please start preparing this order.`;

  await sendWhatsAppText(normalizePhone(BRANCH_NUMBER), message);

  await sendButtons(normalizePhone(BRANCH_NUMBER),
    `Order ${order.id}\n\nWhat would you like to do?`,
    [
      { id: `staff_prepare_${order.id}`, title: "👨‍🍳 Preparing"   },
      { id: `staff_ready_${order.id}`,   title: "✅ Food Ready"   },
      { id: `staff_rider_${order.id}`,   title: "🚴 Rider On Way" }
    ]
  );

  return true;
}

/*--------------------------------------------------------------------------
 WELCOME MESSAGE
--------------------------------------------------------------------------*/
async function showWelcome(to) {
  const message = `👋 *WELCOME TO ${STORE_NAME.toUpperCase()}!* 🍛

We are happy to serve you.
Enjoy delicious rice from our Lapaz location.

🍚 Jollof Rice
🍚 Fried Rice

Please choose what you'd like to eat:`;

  await sendWhatsAppText(to, message);
  return sendInteractiveList(to,
    "🍽️ What would you like to eat?",
    "Menu",
    foodRows()
  );
}

/*--------------------------------------------------------------------------
 PLACE ORDER
--------------------------------------------------------------------------*/
async function placeCustomerOrder(from, session) {
  log("[order:new]", `${from} is placing an order`, { food: session.food, amount: session.foodAmount, fulfillment: session.fulfillment }); // ➕ ADDED
  const order = {
    id:            generateOrderId(),
    customerPhone: from,
    branch:        BRANCH_NAME,
    food:          session.food,
    basePrice:     calculateTotal(session),
    includedChicken: session.includedChicken || 0,
    total:         calculateTotal(session),
    fulfillment:   session.fulfillment,
    address:       session.address || null,
    status:        "NEW",
    createdAt:     new Date().toISOString()
  };

  orders.set(`${order.id}-${Date.now()}-${Math.random()}`, order);
  log("[order:new]", `Order ${order.id} created in memory`, order); // ➕ ADDED
  try {
    await saveOrder(order);
    log("[order:new]", `Order ${order.id} saved to Supabase`); // ➕ ADDED
  } catch (error) {
    logError(`[order:new] Supabase save for ${order.id}`, error); // ➕ CHANGED (was console.error)
  }

  const branchSent = await sendOrderToBranch(order);
  log("[order:new]", `Order ${order.id} sent to branch: ${branchSent}`); // ➕ ADDED
  if (!branchSent) {
    return sendWhatsAppText(from,
      `❌ We couldn't send your order to the ${order.branch} location.\n\nPlease try again later or send *hi* to restart.`
    );
  }

  const addressLine = order.fulfillment === "delivery"
    ? `\n📍 Address: ${order.address}`
    : "";
  const chickenLine = order.includedChicken ? `🍗 Includes ${order.includedChicken} chicken\n` : "";

  await sendWhatsAppText(from,
    `🎉 *ORDER PLACED SUCCESSFULLY!*

🆔 Order: ${order.id}
📍 Location: ${order.branch}
🍽️ Food: ${order.food}
${chickenLine}💵 Total: ${money(order.total)}
🚚 Method: ${order.fulfillment === "pickup" ? "Pick Up" : "Delivery — Pay on Delivery"}${addressLine}
━━━━━━━━━━━━━━

Your order has been sent to the location.
We will notify you when your food is ready. ❤️`
  );

  session.order = order;
  session.step = "ORDER_PLACED";
}

/*--------------------------------------------------------------------------
 STAFF ORDER STATUS
--------------------------------------------------------------------------*/
async function handleStaffAction(from, action, orderId) {
  log("[staff]", `${from} pressed "${action}" for order ${orderId}`); // ➕ ADDED
  const order = Array.from(orders.values()).find(item => item.id === orderId);
  if (!order) {
    logError("[staff]", `Order ${orderId} not found for staff action "${action}"`); // ➕ ADDED
    return sendWhatsAppText(from, `❌ Order ${orderId} was not found.`);
  }

  // ➕ ADDED: if the customer cancelled this order, the old staff buttons must not continue it
  if (order.status === "CANCELLED") {
    log("[staff]", `Order ${order.id} is CANCELLED — ignoring staff action "${action}"`); // ➕ ADDED
    return sendWhatsAppText(from, `❌ Order ${order.id} was already CANCELLED by the customer. No further action needed.`);
  }

  if (action === "prepare") {
    order.status = "PREPARING";
    log("[order:status]", `Order ${order.id} -> PREPARING`); // ➕ ADDED
    await sendWhatsAppText(order.customerPhone,
      `👨‍🍳 *YOUR ORDER IS BEING PREPARED*\n\n🆔 ${order.id}\n🍽️ ${order.food}\n📍 ${order.branch}\n\nYour food is now being prepared.\n\nWe'll notify you when it is ready. ❤️`
    );

    // ➕ ADDED: after the "preparing" message, ask the customer to choose: continue or cancel
    try {
      await sendButtons(order.customerPhone,
        `🍛 Order ${order.id} is being prepared.\n\nDo you still want this order? Please choose below — once it is prepared, it will be served to you.`,
        [
          { id: `customer_continue_${order.id}`, title: "✅ Yes, Continue" },
          { id: `customer_cancel_${order.id}`,   title: "❌ Cancel Order"  }
        ]
      );
    } catch (error) {
      logError(`[order:prepare] Continue/Cancel buttons for ${order.id}`, error); // ➕ CHANGED (was console.error)
    }

    return sendWhatsAppText(from, `👨‍🍳 Order ${order.id} is now marked as *PREPARING*.`);
  }

  if (action === "ready") {
    order.status = "READY";
    log("[order:status]", `Order ${order.id} -> READY`); // ➕ ADDED
    if (order.fulfillment === "pickup") {
      await sendWhatsAppText(order.customerPhone,
        `🎉 *YOUR FOOD IS READY!*\n\n🆔 Order: ${order.id}\n📍 Location: ${order.branch}\n🍽️ ${order.food}\n\nYour food is ready for pickup. 🍛\n\nYou can come to the location and collect your order.\n\nThank you for ordering from ${STORE_NAME}! ❤️`
      );
    } else {
      await sendWhatsAppText(order.customerPhone,
        `🎉 *YOUR FOOD IS READY!*\n\n🆔 Order: ${order.id}\n📍 Location: ${order.branch}\n🍽️ ${order.food}\n\nYour food has been prepared and is ready for delivery.\n\n🚚 Your rider will be on the way shortly.\n\n💵 Please remember: *PAY ON DELIVERY*.`
      );
    }

    if (order.fulfillment === "delivery") {
      await sendButtons(from, `Order ${order.id} is ready.\n\nChoose the next action:`,
        [{ id: `staff_rider_${order.id}`, title: "🚴 Rider On Way" }]
      );
    } else {
      await sendButtons(from, `Order ${order.id} is ready for pickup.`,
        [{ id: `staff_pickup_${order.id}`, title: "📦 Picked Up" }]
      );
    }
    return;
  }

  if (action === "rider") {
    order.status = "OUT_FOR_DELIVERY";
    log("[order:status]", `Order ${order.id} -> OUT_FOR_DELIVERY`); // ➕ ADDED
    await sendWhatsAppText(order.customerPhone,
      `🚴 *YOUR RIDER IS ON THE WAY!*\n\n🆔 Order: ${order.id}\n📍 Location: ${order.branch}\n\nYour food is on the way.\n\n💵 Payment: *PAY ON DELIVERY*\n\nPlease keep your phone available.\n\nThank you for ordering from ${STORE_NAME}! ❤️`
    );
    return sendWhatsAppText(from, `🚴 Order ${order.id} marked as *OUT FOR DELIVERY*.`);
  }

  if (action === "pickup") {
    order.status = "PICKED_UP";
    log("[order:status]", `Order ${order.id} -> PICKED_UP`); // ➕ ADDED
    await sendWhatsAppText(order.customerPhone,
      `✅ *ORDER PICKED UP*\n\n🆔 ${order.id}\n\nThank you for ordering from ${STORE_NAME}! ❤️\n\nEnjoy your food! 🍛`
    );
    return sendWhatsAppText(from, `📦 Order ${order.id} marked as *PICKED UP*.`);
  }

  logError("[staff]", `Unknown staff action "${action}" for order ${orderId}`); // ➕ ADDED
  return sendWhatsAppText(from, "Unknown staff action.");
}

/*--------------------------------------------------------------------------
 ➕ ADDED: CUSTOMER ANSWER AFTER "PREPARING" (continue / cancel)
--------------------------------------------------------------------------*/
async function handleCustomerOrderResponse(from, action, orderId) {
  log("[customer]", `${from} pressed "${action}" for order ${orderId}`); // ➕ ADDED
  // Only the customer who placed the order can answer for it
  const order = Array.from(orders.values()).find(
    item => item.id === orderId && item.customerPhone === from
  );
  if (!order) {
    logError("[customer]", `Order ${orderId} not found for ${from} (or belongs to a different customer)`); // ➕ ADDED
    return sendWhatsAppText(from, `❌ Order ${orderId} was not found.`);
  }

  if (order.status === "CANCELLED") {
    log("[customer]", `Order ${order.id} already CANCELLED — ignoring "${action}"`); // ➕ ADDED
    return sendWhatsAppText(from, `Order ${order.id} has already been cancelled.`);
  }

  /*-- CUSTOMER STILL WANTS THE ORDER --*/
  if (action === "continue") {
    order.customerConfirmed = true;
    log("[customer]", `Order ${order.id} confirmed by customer`); // ➕ ADDED
    return sendWhatsAppText(from,
      `✅ *THANK YOU!*\n\n🆔 Order: ${order.id}\n\nYour order is confirmed. We will notify you when it is ready. ❤️`
    );
  }

  /*-- CUSTOMER CANCELS --*/
  if (action === "cancel") {
    // Too late to cancel once the food is ready / on the way / collected
    if (order.status !== "NEW" && order.status !== "PREPARING") {
      log("[customer]", `Cancel refused for ${order.id} — status is already ${order.status}`); // ➕ ADDED
      return sendWhatsAppText(from,
        `⚠️ Order ${order.id} can no longer be cancelled here because it is already *${order.status.replace(/_/g, " ")}*.\n\nPlease contact ${BRANCH_NAME} directly.`
      );
    }

    order.status = "CANCELLED";
    order.cancelledBy = "customer";
    order.cancelledAt = new Date().toISOString();
    log("[order:status]", `Order ${order.id} -> CANCELLED (by customer ${from})`); // ➕ ADDED

    // ➕ ADDED: save the cancellation so reports still show it after a restart
    try {
      await updateOrderStatus(order, "CANCELLED");
      log("[order:status]", `Order ${order.id} cancellation saved to Supabase`); // ➕ ADDED
    } catch (error) {
      logError(`[order:status] Supabase status update for ${order.id}`, error); // ➕ CHANGED (was console.error)
    }

    // Notify the branch first — this is the important part
    try {
      if (!BRANCH_NUMBER) throw new Error("No WhatsApp number configured for the Lapaz branch");
      await sendWhatsAppText(normalizePhone(BRANCH_NUMBER),
        `❌ *ORDER CANCELLED BY CUSTOMER*

🆔 Order: ${order.id}
📱 Customer: ${order.customerPhone}
🍽️ Food: ${order.food}
💵 Total: ${money(order.total)}
🚚 Method: ${order.fulfillment === "pickup" ? "PICK UP" : "DELIVERY — PAY ON DELIVERY"}
━━━━━━━━━━━━━━

Please STOP preparing this order.`
      );
    } catch (error) {
      logError(`[order:status] Branch cancel notification for ${order.id}`, error); // ➕ CHANGED (was console.error)
    }

    return sendWhatsAppText(from,
      `❌ *ORDER CANCELLED*\n\n🆔 ${order.id}\n\nYour order has been cancelled and ${BRANCH_NAME} has been notified.\n\nSend *hi* whenever you want to order again.`
    );
  }
}

/*--------------------------------------------------------------------------
 REPORTS
--------------------------------------------------------------------------*/
async function showReportOptions(to) {
  const session = getSession(to);
  session.step = "REPORT_PERIOD";
  return sendButtons(to,
    `📊 *${BRANCH_NAME} REPORT*\n\nWhich report would you like?`,
    [
      { id: "report_daily", title: "Daily" },
      { id: "report_weekly", title: "Weekly" },
      { id: "report_monthly", title: "Monthly" }
    ]
  );
}

async function sendBranchReport(to, period) {
  log("[report]", `Generating ${period} report for ${BRANCH_NAME}, requested by ${to}`); // ➕ ADDED
  try {
    const reportOrders = await getOrders(BRANCH_NAME, period, orders);
    log("[report]", `${reportOrders.length} order(s) found for ${period}`); // ➕ ADDED
    const pdf = await createReportPdf(BRANCH_NAME, period, reportOrders);
    const filename = `sweet-bite-${BRANCH_NAME.toLowerCase()}-${period}.pdf`;

    // ➕ ADDED: mention cancelled orders in the chat message
    const cancelledCount = reportOrders.filter(order => String(order.status || "").toUpperCase() === "CANCELLED").length;
    await sendWhatsAppText(to,
      `📊 ${period[0].toUpperCase() + period.slice(1)} report for ${BRANCH_NAME}: ${reportOrders.length} order(s)${cancelledCount ? ` (${cancelledCount} cancelled)` : ""}.`
    );
    return sendWhatsAppDocument(to, pdf, filename, `${BRANCH_NAME} ${period} order report`);
  } catch (error) {
    logError(`[report] ${BRANCH_NAME} ${period} for ${to}`, error); // ➕ CHANGED (was console.error)
    return sendWhatsAppText(to,
      "❌ I could not generate the report right now. Please try again in a moment."
    );
  }
}

/*--------------------------------------------------------------------------
 HANDLE TEXT
--------------------------------------------------------------------------*/
async function handleText(from, text) {
  const input = String(text || "").trim();
  const lower = input.toLowerCase();
  const isStaff = isBranchPhone(from);
  log("[text]", `${from}${isStaff ? " (STAFF)" : ""} :: "${input}"`); // ➕ ADDED

  if (isStaff && lower === "report") {
    log("[text]", `${from} requested the report menu`); // ➕ ADDED
    return showReportOptions(from);
  }

  const session = getSession(from);
  if (isStaff && session.step === "REPORT_PERIOD" && ["daily", "weekly", "monthly"].includes(lower)) {
    session.step = "WELCOME";
    log("[text]", `${from} chose "${lower}" report`); // ➕ ADDED
    return sendBranchReport(from, lower);
  }

  if (["hi","hello","hey","start","menu"].includes(lower)) {
    log("[text]", `${from} restarted the session`); // ➕ ADDED
    resetSession(from);
    return showWelcome(from);
  }

  if (lower === "restart" || lower === "cancel") {
    log("[text]", `${from} typed "${lower}" — session reset`); // ➕ ADDED
    resetSession(from);
    return sendWhatsAppText(from,
      "🔄 Your current order has been cancelled.\n\nSend *hi* to start a new order."
    );
  }

  if (session.step === "ADDRESS") {
    session.address = input;
    session.step = "CONFIRMATION";
    log("[text]", `${from} provided delivery address: "${input}"`); // ➕ ADDED
    return sendOrderConfirmation(from, session);
  }

  log("[text]", `${from} sent free text at step "${session.step}" — nothing matched, showing fallback`); // ➕ ADDED
  return sendWhatsAppText(from,
    "Please use the selection options above.\n\nSend *hi* if you want to start again."
  );
}

/*--------------------------------------------------------------------------
 HANDLE CUSTOMER INTERACTIVE
--------------------------------------------------------------------------*/
async function handleCustomerInteractive(from, message) {
  const reply = message.interactive;
  const id = reply?.list_reply?.id || reply?.button_reply?.id;
  if (!id) {
    log("[interactive]", `${from} sent an interactive reply with no id — ignored`); // ➕ ADDED
    return;
  }
  log("[interactive]", `${from} selected "${id}" (step was "${getSession(from).step}")`); // ➕ ADDED

  const session = getSession(from);

  /*-- REPORT PERIOD (staff, via buttons) --*/
  if (id.startsWith("report_")) {
    const period = id.replace("report_", "");
    const isStaff = isBranchPhone(from);
    if (isStaff && session.step === "REPORT_PERIOD" && ["daily", "weekly", "monthly"].includes(period)) {
      session.step = "WELCOME";
      return sendBranchReport(from, period);
    }
    return;
  }

  /*-- FOOD MENU (Jollof Rice / Fried Rice) --*/
  if (id.startsWith("food_")) {
    const food = FOODS[id];
    if (!food) {
      logError("[interactive]", `Unknown food id "${id}" from ${from}`); // ➕ ADDED
      return;
    }
    log("[interactive]", `${from} chose ${food}`); // ➕ ADDED

    session.food = food;
    session.foodAmount = null;
    session.step = "PRICE";
    return sendInteractiveList(from,
      `🍚 *${food}*\n\nChoose your price:`,
      "Prices",
      priceRows()
    );
  }

  /*-- PRICE SELECTION --*/
  if (id.startsWith("price_")) {
    const amount = Number(id.replace("price_", ""));
    const portion = RICE_PORTIONS.find(item => item.amount === amount);
    if (!portion) {
      logError("[interactive]", `Unknown price id "${id}" from ${from}`); // ➕ ADDED
      return;
    }
    log("[interactive]", `${from} chose ${money(amount)} (${portion.chicken} chicken) for ${session.food}`); // ➕ ADDED

    session.foodAmount = portion.amount;
    session.includedChicken = portion.chicken;
    session.step = "FULFILLMENT";
    return showFulfillmentOptions(from);
  }

  /*-- PICKUP --*/
  if (id === "pickup") {
    log("[interactive]", `${from} chose Pick Up`); // ➕ ADDED
    session.fulfillment = "pickup";
    session.step = "CONFIRMATION";
    return sendOrderConfirmation(from, session);
  }

  /*-- DELIVERY --*/
  if (id === "delivery") {
    log("[interactive]", `${from} chose Delivery — awaiting address`); // ➕ ADDED
    session.fulfillment = "delivery";
    session.step = "ADDRESS";
    return sendWhatsAppText(from,
      `🚚 *DELIVERY SELECTED*\n\n💵 Payment is *ON DELIVERY*.\n\nPlease send your full delivery address.\n\nFor example:\n\nArea:\nHouse number/name:\nNearest landmark:\n\nPlease send all the details in one message.`
    );
  }

  /*-- CONFIRM ORDER --*/
  if (id === "confirm_order") {
    log("[interactive]", `${from} confirmed the order at checkout`); // ➕ ADDED
    return placeCustomerOrder(from, session);
  }

  /*-- CANCEL ORDER --*/
  if (id === "cancel_order") {
    log("[interactive]", `${from} cancelled at checkout (before placing the order)`); // ➕ ADDED
    resetSession(from);
    return sendWhatsAppText(from, "❌ Order cancelled.\n\nSend *hi* whenever you want to order again.");
  }
}

/*--------------------------------------------------------------------------
 HANDLE INTERACTIVE (detects staff vs customer)
--------------------------------------------------------------------------*/
async function handleInteractive(from, message) {
  const reply = message.interactive;
  const id = reply?.list_reply?.id || reply?.button_reply?.id;
  if (!id) {
    log("[interactive]", `${from} sent an interactive message with no usable id (type: ${reply?.type})`); // ➕ ADDED
    return;
  }

  if (id.startsWith("staff_prepare_")) return handleStaffAction(from, "prepare", id.replace("staff_prepare_", ""));
  if (id.startsWith("staff_ready_"))   return handleStaffAction(from, "ready",   id.replace("staff_ready_", ""));
  if (id.startsWith("staff_rider_"))   return handleStaffAction(from, "rider",   id.replace("staff_rider_", ""));
  if (id.startsWith("staff_pickup_"))  return handleStaffAction(from, "pickup",  id.replace("staff_pickup_", ""));

  // ➕ ADDED: customer's answer after the "preparing" message
  if (id.startsWith("customer_continue_")) return handleCustomerOrderResponse(from, "continue", id.replace("customer_continue_", ""));
  if (id.startsWith("customer_cancel_"))   return handleCustomerOrderResponse(from, "cancel",   id.replace("customer_cancel_", ""));

  return handleCustomerInteractive(from, message);
}

/*--------------------------------------------------------------------------
 WEBHOOK VERIFICATION
--------------------------------------------------------------------------*/
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    log("[webhook]", "Verification succeeded"); // ➕ ADDED
    return res.status(200).send(challenge);
  }
  logError("[webhook]", `Verification failed (mode="${mode}", token mismatch)`); // ➕ ADDED
  return res.sendStatus(403);
});

/*--------------------------------------------------------------------------
 WHATSAPP WEBHOOK
--------------------------------------------------------------------------*/
app.post("/webhook", async (req, res) => {
  // ➕ ADDED: unconditional log — proves the request reached this server at all,
  // even if the body below turns out to be empty or in an unexpected shape.
  log("[webhook]", `POST /webhook hit — body keys: [${Object.keys(req.body || {}).join(", ") || "EMPTY"}]`);

  res.sendStatus(200);
  try {
    const value    = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages || [];

    // ➕ ADDED: if WhatsApp sent something other than a new message (e.g. a delivery/read
    // status update, or a differently-shaped payload), say so instead of going quiet.
    if (!messages.length) {
      log("[webhook]", `No "messages" array found. object=${req.body?.object}, statuses=${!!value?.statuses}, raw value keys=[${Object.keys(value || {}).join(", ")}]`);
      return;
    }

    log("[webhook]", `Received ${messages.length} message(s)`); // ➕ ADDED

    for (const message of messages) {
      if (!message.from) {
        logError("[webhook]", "Skipping message with no \"from\" field"); // ➕ ADDED
        continue;
      }
      const from = normalizePhone(message.from);
      log("[webhook]", `${from} :: type = ${message.type}`); // ➕ ADDED

      if (message.type === "text") {
        await handleText(from, message.text?.body);
        continue;
      }
      if (message.type === "interactive") {
        await handleInteractive(from, message);
        continue;
      }
      log("[webhook]", `${from} sent unsupported message type "${message.type}" — sending fallback`); // ➕ ADDED
      await sendWhatsAppText(from, "Please use the options provided.");
    }
  } catch (error) {
    logError("[webhook]", error); // ➕ CHANGED (was console.error)
  }
});

/*--------------------------------------------------------------------------
 ROUTES
--------------------------------------------------------------------------*/
app.get("/",       (req, res) => res.json({ ok: true, store: STORE_NAME, service: "Sweet Bite Food Ordering Bot", branch: BRANCH_NAME }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime(), sessions: sessions.size, orders: orders.size, branch: BRANCH_NAME }));
app.get("/orders", (req, res) => res.json(Array.from(orders.values())));

/*--------------------------------------------------------------------------
 START
--------------------------------------------------------------------------*/
app.get("/health", (req, res) => {
  res.status(200).send("Bot is alive!");
});

app.listen(PORT, () => {
  log("[boot]", `🍛 ${STORE_NAME} food bot running on port ${PORT}`); // ➕ CHANGED (was console.log)
  log("[boot]", `Branch: ${BRANCH_NAME} (+${normalizePhone(BRANCH_NUMBER) || "NOT SET"})`); // ➕ CHANGED
  log("[boot]", `Supabase: ${process.env.SUPABASE_URL ? "configured" : "not configured (in-memory only)"}`); // ➕ ADDED
});
