require("dotenv").config();

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const { createReportPdf, getOrders, saveOrder } = require("./reports");

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
  return axios.post(WA_URL, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

async function sendWhatsAppDocument(to, pdfBuffer, filename, caption) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", pdfBuffer, { filename, contentType: "application/pdf" });

  const upload = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`,
    form,
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, ...form.getHeaders() } }
  );

  return axios.post(WA_URL, {
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
}

/*--------------------------------------------------------------------------
 WHATSAPP BUTTONS
--------------------------------------------------------------------------*/
async function sendButtons(to, body, buttons) {
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
  return axios.post(WA_URL, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

/*--------------------------------------------------------------------------
 WHATSAPP LIST
--------------------------------------------------------------------------*/
async function sendInteractiveList(to, body, section, rows, buttonText = "Select") {
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
  return axios.post(WA_URL, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
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
    console.error("No WhatsApp number configured for the Lapaz branch");
    return false;
  }

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
  try {
    await saveOrder(order);
  } catch (error) {
    console.error("SUPABASE ORDER SAVE ERROR:", error.message);
  }

  const branchSent = await sendOrderToBranch(order);
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
  const order = Array.from(orders.values()).find(item => item.id === orderId);
  if (!order) return sendWhatsAppText(from, `❌ Order ${orderId} was not found.`);

  if (action === "prepare") {
    order.status = "PREPARING";
    await sendWhatsAppText(order.customerPhone,
      `👨‍🍳 *YOUR ORDER IS BEING PREPARED*\n\n🆔 ${order.id}\n🍽️ ${order.food}\n📍 ${order.branch}\n\nYour food is now being prepared.\n\nWe'll notify you when it is ready. ❤️`
    );
    return sendWhatsAppText(from, `👨‍🍳 Order ${order.id} is now marked as *PREPARING*.`);
  }

  if (action === "ready") {
    order.status = "READY";
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
    await sendWhatsAppText(order.customerPhone,
      `🚴 *YOUR RIDER IS ON THE WAY!*\n\n🆔 Order: ${order.id}\n📍 Location: ${order.branch}\n\nYour food is on the way.\n\n💵 Payment: *PAY ON DELIVERY*\n\nPlease keep your phone available.\n\nThank you for ordering from ${STORE_NAME}! ❤️`
    );
    return sendWhatsAppText(from, `🚴 Order ${order.id} marked as *OUT FOR DELIVERY*.`);
  }

  if (action === "pickup") {
    order.status = "PICKED_UP";
    await sendWhatsAppText(order.customerPhone,
      `✅ *ORDER PICKED UP*\n\n🆔 ${order.id}\n\nThank you for ordering from ${STORE_NAME}! ❤️\n\nEnjoy your food! 🍛`
    );
    return sendWhatsAppText(from, `📦 Order ${order.id} marked as *PICKED UP*.`);
  }

  return sendWhatsAppText(from, "Unknown staff action.");
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
  try {
    const reportOrders = await getOrders(BRANCH_NAME, period, orders);
    const pdf = await createReportPdf(BRANCH_NAME, period, reportOrders);
    const filename = `sweet-bite-${BRANCH_NAME.toLowerCase()}-${period}.pdf`;

    await sendWhatsAppText(to,
      `📊 ${period[0].toUpperCase() + period.slice(1)} report for ${BRANCH_NAME}: ${reportOrders.length} order(s).`
    );
    return sendWhatsAppDocument(to, pdf, filename, `${BRANCH_NAME} ${period} order report`);
  } catch (error) {
    console.error("REPORT ERROR:", error.response?.data || error.message);
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

  if (isStaff && lower === "report") return showReportOptions(from);

  const session = getSession(from);
  if (isStaff && session.step === "REPORT_PERIOD" && ["daily", "weekly", "monthly"].includes(lower)) {
    session.step = "WELCOME";
    return sendBranchReport(from, lower);
  }

  if (["hi","hello","hey","start","menu"].includes(lower)) {
    resetSession(from);
    return showWelcome(from);
  }

  if (lower === "restart" || lower === "cancel") {
    resetSession(from);
    return sendWhatsAppText(from,
      "🔄 Your current order has been cancelled.\n\nSend *hi* to start a new order."
    );
  }

  if (session.step === "ADDRESS") {
    session.address = input;
    session.step = "CONFIRMATION";
    return sendOrderConfirmation(from, session);
  }

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
  if (!id) return;

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
    if (!food) return;

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
    if (!portion) return;

    session.foodAmount = portion.amount;
    session.includedChicken = portion.chicken;
    session.step = "FULFILLMENT";
    return showFulfillmentOptions(from);
  }

  /*-- PICKUP --*/
  if (id === "pickup") {
    session.fulfillment = "pickup";
    session.step = "CONFIRMATION";
    return sendOrderConfirmation(from, session);
  }

  /*-- DELIVERY --*/
  if (id === "delivery") {
    session.fulfillment = "delivery";
    session.step = "ADDRESS";
    return sendWhatsAppText(from,
      `🚚 *DELIVERY SELECTED*\n\n💵 Payment is *ON DELIVERY*.\n\nPlease send your full delivery address.\n\nFor example:\n\nArea:\nHouse number/name:\nNearest landmark:\n\nPlease send all the details in one message.`
    );
  }

  /*-- CONFIRM ORDER --*/
  if (id === "confirm_order") return placeCustomerOrder(from, session);

  /*-- CANCEL ORDER --*/
  if (id === "cancel_order") {
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
  if (!id) return;

  if (id.startsWith("staff_prepare_")) return handleStaffAction(from, "prepare", id.replace("staff_prepare_", ""));
  if (id.startsWith("staff_ready_"))   return handleStaffAction(from, "ready",   id.replace("staff_ready_", ""));
  if (id.startsWith("staff_rider_"))   return handleStaffAction(from, "rider",   id.replace("staff_rider_", ""));
  if (id.startsWith("staff_pickup_"))  return handleStaffAction(from, "pickup",  id.replace("staff_pickup_", ""));

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
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/*--------------------------------------------------------------------------
 WHATSAPP WEBHOOK
--------------------------------------------------------------------------*/
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value    = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages || [];

    for (const message of messages) {
      if (!message.from) continue;
      const from = normalizePhone(message.from);

      if (message.type === "text") {
        await handleText(from, message.text?.body);
        continue;
      }
      if (message.type === "interactive") {
        await handleInteractive(from, message);
        continue;
      }
      await sendWhatsAppText(from, "Please use the options provided.");
    }
  } catch (error) {
    console.error("WEBHOOK ERROR:", error.response?.data || error.message);
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
app.listen(PORT, () => {
  console.log(`🍛 ${STORE_NAME} food bot running on port ${PORT}`);
  console.log("Branch:", BRANCH_NAME);
});
