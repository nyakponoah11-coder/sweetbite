require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { createReportPdf, getOrders, saveOrder, updateOrderStatus } = require("./reports");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const {
  LAPAZ_BRANCH_NUMBER,
  STORE_NAME = "Sweet Bite"
} = process.env;

/*--------------------------------------------------------------------------
 ACTIVITY BUFFER & LOGGING
--------------------------------------------------------------------------*/
const activities = [];
const MAX_ACTIVITIES = 250;

function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function classifyTag(tag) {
  const t = String(tag || "").toLowerCase();
  if (t.includes("baileys")) return "baileys";
  if (t.includes("text")) return "text";
  if (t.includes("order")) return "order";
  if (t.includes("staff")) return "staff";
  if (t.includes("send")) return "send";
  if (t.includes("report")) return "report";
  if (t.includes("status")) return "status";
  return "system";
}

function recordActivity(tag, type, message, data = null, isError = false) {
  const activity = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    timestamp: new Date().toISOString(),
    time: ts(),
    tag,
    type,
    message: typeof message === "string" ? message : JSON.stringify(message),
    data: data ? (typeof data === "object" ? data : { raw: data }) : null,
    isError
  };
  activities.unshift(activity);
  if (activities.length > MAX_ACTIVITIES) activities.pop();
  return activity;
}

function log(tag, ...args) {
  const str = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  console.log(`[${ts()}] ${tag}`, ...args);
  const data = args.length === 1 && typeof args[0] === "object" ? args[0] : null;
  recordActivity(tag, classifyTag(tag), str, data, false);
}

function logError(tag, error) {
  const detail = error?.message || (typeof error === "string" ? error : JSON.stringify(error));
  console.error(`[${ts()}] ${tag} ❌`, detail);
  recordActivity(tag, "error", typeof detail === "string" ? detail : JSON.stringify(detail), null, true);
}

process.on("uncaughtException", (error) => {
  logError("[crash] uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  logError("[crash] unhandledRejection", reason);
});
process.on("SIGTERM", () => log("[boot]", "Received SIGTERM — stopping"));
process.on("SIGINT",  () => log("[boot]", "Received SIGINT — stopping"));

/*--------------------------------------------------------------------------
 BRANCH — only one branch, LAPAZ
--------------------------------------------------------------------------*/
const BRANCH_NAME = "Lapaz";
const BRANCH_NUMBER = LAPAZ_BRANCH_NUMBER;

/*--------------------------------------------------------------------------
 MENU — Jollof Rice & Fried Rice only, portions ₵30 - ₵60
--------------------------------------------------------------------------*/
const RICE_PORTIONS = [
  { id: 1, amount: 30, chicken: 1 },
  { id: 2, amount: 40, chicken: 1 },
  { id: 3, amount: 50, chicken: 2 },
  { id: 4, amount: 60, chicken: 3 }
];

const FOODS = {
  1: "Jollof Rice",
  2: "Fried Rice"
};

/*--------------------------------------------------------------------------
 SESSIONS AND ORDERS
--------------------------------------------------------------------------*/
const sessions = new Map();
const orders   = new Map();

// Deduplicate recently seen message IDs
const PROCESSED_MESSAGE_TTL_MS = 30 * 60 * 1000;
const processedMessageIds = new Map();
setInterval(() => {
  const cutoff = Date.now() - PROCESSED_MESSAGE_TTL_MS;
  for (const [id, seenAt] of processedMessageIds) {
    if (seenAt < cutoff) processedMessageIds.delete(id);
  }
}, 5 * 60 * 1000).unref();

function alreadyProcessed(messageId) {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, Date.now());
  return false;
}

/*--------------------------------------------------------------------------
 PHONE NUMBER HELPERS
--------------------------------------------------------------------------*/
function normalizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("233")) return phone;
  if (phone.startsWith("0")) return "233" + phone.substring(1);
  return phone;
}

function phoneToJid(phone) {
  const clean = normalizePhone(phone);
  return `${clean}@s.whatsapp.net`;
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
      order: null,
      customerName: null
    });
  }
  return sessions.get(phone);
}

function resetSession(phone) {
  const existing = sessions.get(phone);
  sessions.set(phone, {
    step: "WELCOME",
    food: null,
    foodAmount: null,
    includedChicken: 0,
    fulfillment: null,
    address: null,
    order: null,
    customerName: existing?.customerName || null
  });
}

function isBranchPhone(phone) {
  if (!BRANCH_NUMBER) return false;
  return normalizePhone(phone) === normalizePhone(BRANCH_NUMBER);
}

/*--------------------------------------------------------------------------
 BAILEYS WHATSAPP CLIENT (Zero Meta API Fees)
--------------------------------------------------------------------------*/
let sock = null;
let isBaileysConnected = false;
let connectedUser = null;
let currentQr = null;
let currentQrDataUrl = null;
const authFolder = path.join(__dirname, "baileys_auth_info");

async function startBaileys() {
  try {
    if (!fs.existsSync(authFolder)) {
      fs.mkdirSync(authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Sweet Bite Food Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = qr;
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        } catch (e) {
          logError("[baileys:qr]", e);
        }
        log("[baileys]", "🔑 New WhatsApp QR code generated! Scan it from WhatsApp on your phone or via the web dashboard.");
        console.log("\n==================== SCAN THIS QR CODE WITH WHATSAPP ====================\n");
        qrcodeTerminal.generate(qr, { small: true });
        console.log("\n========================================================================\n");
      }

      if (connection === "close") {
        isBaileysConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        log("[baileys]", `Connection closed (code: ${statusCode || "unknown"}). Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(startBaileys, 4000);
        } else {
          log("[baileys]", "Logged out of WhatsApp. Clearing session credentials and requesting new QR code...");
          try {
            fs.rmSync(authFolder, { recursive: true, force: true });
          } catch (err) {}
          currentQr = null;
          currentQrDataUrl = null;
          connectedUser = null;
          setTimeout(startBaileys, 3000);
        }
      } else if (connection === "open") {
        isBaileysConnected = true;
        currentQr = null;
        currentQrDataUrl = null;
        connectedUser = sock.user?.id ? sock.user.id.split(":")[0] : "connected";
        log("[baileys]", `🎉 Connected to WhatsApp successfully! Logged in as +${connectedUser}`);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      if (!messages || !messages.length) return;
      for (const msg of messages) {
        try {
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid === "status@broadcast") continue;
          if (!msg.message) continue;

          const messageId = msg.key.id;
          if (alreadyProcessed(messageId)) {
            log("[baileys]", `Duplicate message ${messageId} ignored`);
            continue;
          }

          const remoteJid = msg.key.remoteJid;
          const from = normalizePhone(remoteJid.replace(/@.+/, ""));
          const customerName = msg.pushName || null;

          // Extract text from conversation, extendedTextMessage, or image caption
          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";

          if (!text || !text.trim()) continue;

          await handleIncomingText(from, text.trim(), customerName);
        } catch (err) {
          logError("[baileys:upsert]", err);
        }
      }
    });

  } catch (error) {
    logError("[baileys:start]", error);
    setTimeout(startBaileys, 5000);
  }
}

/*--------------------------------------------------------------------------
 WHATSAPP OUTBOUND SENDING (BAILEYS)
--------------------------------------------------------------------------*/
async function sendWhatsAppText(to, body) {
  log("[send:text]", `-> ${to} :: ${String(body).replace(/\n/g, " | ").slice(0, 120)}`);

  if (!sock || !isBaileysConnected) {
    log("[send:mock]", `Mock dispatch to ${to} (WhatsApp client not connected yet)`);
    return { mock: true };
  }

  try {
    const jid = phoneToJid(to);
    return await sock.sendMessage(jid, { text: body });
  } catch (error) {
    logError(`[send:text] to ${to}`, error);
    return { failed: true, error: error.message };
  }
}

async function sendWhatsAppDocument(to, pdfBuffer, filename, caption) {
  log("[send:doc]", `-> ${to} :: ${filename} (${pdfBuffer.length} bytes)`);

  if (!sock || !isBaileysConnected) {
    log("[send:mock]", `Mock doc dispatch to ${to} (${filename})`);
    return { mock: true };
  }

  try {
    const jid = phoneToJid(to);
    return await sock.sendMessage(jid, {
      document: pdfBuffer,
      mimetype: "application/pdf",
      fileName: filename,
      caption: caption || filename
    });
  } catch (error) {
    logError(`[send:doc] to ${to}`, error);
    return { failed: true, error: error.message };
  }
}

/*--------------------------------------------------------------------------
 ORDER HELPERS
--------------------------------------------------------------------------*/
function calculateTotal(session) {
  return Number(session.foodAmount) || 0;
}

function generateOrderId() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return `SB-${day}${month}${hour}${minutes}`;
}

function customerLabel(order) {
  const phone = `+${order.customerPhone}`;
  return order.customerName ? `${order.customerName} (${phone})` : phone;
}

function buildOrderSummary(session) {
  const chickenLine = session.includedChicken ? `🍗 Includes ${session.includedChicken} chicken\n` : "";
  return `🛍️ *${STORE_NAME.toUpperCase()} ORDER*

📍 Location: ${BRANCH_NAME}
🍽️ Food: ${session.food}
${chickenLine}💵 *TOTAL: ${money(calculateTotal(session))}*
🚚 Method: ${session.fulfillment === "pickup" ? "Pick Up" : "Delivery — Pay on Delivery"}${session.fulfillment === "delivery" ? `\n📍 Address:\n${session.address}` : ""}`;
}

/*--------------------------------------------------------------------------
 CONVERSATION SCREENS & PROMPTS
--------------------------------------------------------------------------*/
async function showWelcome(to) {
  const message = `👋 *WELCOME TO ${STORE_NAME.toUpperCase()}!* 🍛

We are happy to serve you.
Enjoy delicious rice from our ${BRANCH_NAME} branch!

*SECRET:* You will be served very fast without joining queue.

Please choose what you'd like to eat:
1️⃣ *Jollof Rice*
2️⃣ *Fried Rice*

_(Reply with *1* or *2*)_`;

  return sendWhatsAppText(to, message);
}

async function showPriceOptions(to, foodName) {
  const message = `🍚 *${foodName.toUpperCase()}*

Choose your portion size:
1️⃣ *₵30.00* (Includes 1 chicken)
2️⃣ *₵40.00* (Includes 1 chicken)
3️⃣ *₵50.00* (Includes 2 chicken)
4️⃣ *₵60.00* (Includes 3 chicken)

_(Reply with *1*, *2*, *3*, or *4*)_`;

  return sendWhatsAppText(to, message);
}

async function showFulfillmentOptions(to) {
  const message = `🚚 *How would you like to receive your food?*

1️⃣ *Pick Up* (Come to our ${BRANCH_NAME} branch)
2️⃣ *Delivery* (Pay the rider on delivery)

_(Reply with *1* for Pick Up, or *2* for Delivery)_`;

  return sendWhatsAppText(to, message);
}

async function sendOrderConfirmation(to, session) {
  const total = calculateTotal(session);
  const message = `🧾 *PLEASE CONFIRM YOUR ORDER*

${buildOrderSummary(session)}
━━━━━━━━━━━━━━

Would you like to place this order?
1️⃣ *Yes, Place Order*
2️⃣ *Cancel*

_(Reply with *1* to place order or *2* to cancel)_`;

  return sendWhatsAppText(to, message);
}

/*--------------------------------------------------------------------------
 SEND ORDER TO BRANCH
--------------------------------------------------------------------------*/
async function sendOrderToBranch(order) {
  if (!BRANCH_NUMBER) {
    logError("[order:branch]", `No WhatsApp number configured for ${BRANCH_NAME} branch (set LAPAZ_BRANCH_NUMBER)`);
    return false;
  }
  log("[order:branch]", `Notifying ${BRANCH_NAME} (+${normalizePhone(BRANCH_NUMBER)}) about order ${order.id}`);

  const chickenLine = order.includedChicken ? `🍗 Includes ${order.includedChicken} chicken\n` : "";

  const message = `🔔 *NEW ORDER*

🆔 Order: *${order.id}*
📍 Branch: ${order.branch}
📱 Customer: ${customerLabel(order)}
🍽️ Food: ${order.food}
${chickenLine}━━━━━━━━━━━━━
💵 *TOTAL: ${money(order.total)}*
🚚 Method: ${order.fulfillment === "pickup" ? "PICK UP" : "DELIVERY — PAY ON DELIVERY"}${order.fulfillment === "delivery" ? `\n📍 DELIVERY ADDRESS:\n${order.address}` : ""}
━━━━━━━━━━━━━━

*Staff Quick Actions:*
Reply to this chat with:
• *prepare ${order.id}* (Mark preparing)
• *ready ${order.id}* (Mark food ready)
• *rider ${order.id}* (Mark rider on way)
• *pickup ${order.id}* (Mark collected)`;

  await sendWhatsAppText(normalizePhone(BRANCH_NUMBER), message);
  return true;
}

/*--------------------------------------------------------------------------
 PLACE CUSTOMER ORDER
--------------------------------------------------------------------------*/
async function placeCustomerOrder(from, session) {
  log("[order:new]", `${from} is placing an order`, { food: session.food, amount: session.foodAmount, fulfillment: session.fulfillment });
  const order = {
    id: generateOrderId(),
    customerPhone: from,
    customerName: session.customerName || null,
    branch: BRANCH_NAME,
    food: session.food,
    basePrice: calculateTotal(session),
    includedChicken: session.includedChicken || 0,
    total: calculateTotal(session),
    fulfillment: session.fulfillment,
    address: session.address || null,
    status: "NEW",
    createdAt: new Date().toISOString()
  };

  orders.set(order.id, order);
  log("[order:new]", `Order ${order.id} created in memory`, order);

  try {
    await saveOrder(order);
    log("[order:new]", `Order ${order.id} saved to Supabase`);
  } catch (error) {
    logError(`[order:new] Supabase save for ${order.id}`, error);
  }

  const branchSent = await sendOrderToBranch(order);
  log("[order:new]", `Order ${order.id} sent to branch: ${branchSent}`);

  if (!branchSent) {
    return sendWhatsAppText(from,
      `❌ We couldn't send your order to the ${order.branch} location.\n\nPlease try again later or reply *hi* to restart.`
    );
  }

  const addressLine = order.fulfillment === "delivery" ? `\n📍 Address: ${order.address}` : "";
  const chickenLine = order.includedChicken ? `🍗 Includes ${order.includedChicken} chicken\n` : "";

  await sendWhatsAppText(from,
    `🎉 *ORDER PLACED SUCCESSFULLY!*

🆔 Order: *${order.id}*
📍 Location: ${order.branch}
🍽️ Food: ${order.food}
${chickenLine}💵 Total: ${money(order.total)}
🚚 Method: ${order.fulfillment === "pickup" ? "Pick Up" : "Delivery — Pay on Delivery"}${addressLine}
━━━━━━━━━━━━━━

Your order has been sent to our kitchen.
We will notify you as soon as your food is prepared! ❤️`
  );

  session.order = order;
  session.step = "ORDER_PLACED";
}

/*--------------------------------------------------------------------------
 NOTIFY CUSTOMER & STAFF ACTIONS
--------------------------------------------------------------------------*/
async function notifyCustomer(order, text, staffPhone) {
  try {
    await sendWhatsAppText(order.customerPhone, text);
  } catch (error) {
    logError(`[order:notify] Could not reach customer ${order.customerPhone}`, error);
    if (staffPhone) {
      await sendWhatsAppText(staffPhone,
        `⚠️ *COULD NOT NOTIFY CUSTOMER*\n\n🆔 Order: ${order.id}\n📱 Customer: ${customerLabel(order)}\n\nPlease contact them directly.`
      ).catch(() => {});
    }
  }
}

async function handleStaffAction(from, action, orderId) {
  log("[staff]", `${from} triggered "${action}" for order ${orderId}`);
  const order = Array.from(orders.values()).find(item => item.id.toLowerCase() === orderId.toLowerCase());
  if (!order) {
    logError("[staff]", `Order ${orderId} not found for staff action "${action}"`);
    return sendWhatsAppText(from, `❌ Order ${orderId} was not found.`);
  }

  if (order.status === "CANCELLED") {
    log("[staff]", `Order ${order.id} is CANCELLED — ignoring staff action "${action}"`);
    return sendWhatsAppText(from, `❌ Order ${order.id} was already CANCELLED. No further action needed.`);
  }

  if (action === "prepare") {
    order.status = "PREPARING";
    log("[order:status]", `Order ${order.id} -> PREPARING`);
    try { await updateOrderStatus(order, "PREPARING"); } catch (e) {}

    await notifyCustomer(order,
      `👨‍🍳 *YOUR ORDER IS BEING PREPARED*\n\n🆔 Order: ${order.id}\n🍽️ ${order.food}\n📍 ${order.branch}\n\nYour food is now being prepared.\nWe'll notify you when it is ready. ❤️\n\n_(Reply *cancel ${order.id}* if you need to cancel before preparation finishes)_`,
      from
    );

    return sendWhatsAppText(from, `👨‍🍳 Order ${order.id} is now marked as *PREPARING*.\n\nWhen ready, reply:\n*ready ${order.id}*`);
  }

  if (action === "ready") {
    order.status = "READY";
    log("[order:status]", `Order ${order.id} -> READY`);
    try { await updateOrderStatus(order, "READY"); } catch (e) {}

    if (order.fulfillment === "pickup") {
      await notifyCustomer(order,
        `🎉 *YOUR FOOD IS READY!*\n\n🆔 Order: ${order.id}\n📍 Location: ${order.branch}\n🍽️ ${order.food}\n\nYour food is hot and ready for pickup! 🍛\nPlease come to our counter to collect.\n\nThank you for choosing ${STORE_NAME}! ❤️`,
        from
      );
      return sendWhatsAppText(from, `✅ Order ${order.id} marked as *READY*. When picked up, reply:\n*pickup ${order.id}*`);
    } else {
      await notifyCustomer(order,
        `🎉 *YOUR FOOD IS READY!*\n\n🆔 Order: ${order.id}\n📍 Location: ${order.branch}\n🍽️ ${order.food}\n\nYour food is ready and will be handed to the dispatch rider.\n🚚 Remember: *PAY ON DELIVERY*.\n\nThank you for choosing ${STORE_NAME}! ❤️`,
        from
      );
      return sendWhatsAppText(from, `✅ Order ${order.id} marked as *READY*. When rider leaves, reply:\n*rider ${order.id}*`);
    }
  }

  if (action === "rider") {
    order.status = "OUT_FOR_DELIVERY";
    log("[order:status]", `Order ${order.id} -> OUT_FOR_DELIVERY`);
    try { await updateOrderStatus(order, "OUT_FOR_DELIVERY"); } catch (e) {}

    await notifyCustomer(order,
      `🚴 *YOUR RIDER IS ON THE WAY!*\n\n🆔 Order: ${order.id}\n📍 Location: ${order.branch}\n\nYour food is on the way to your delivery address!\n💵 Payment: *PAY ON DELIVERY*\n\nPlease keep your phone reachable. ❤️`,
      from
    );
    return sendWhatsAppText(from, `🚴 Order ${order.id} marked as *OUT FOR DELIVERY*.`);
  }

  if (action === "pickup") {
    order.status = "PICKED_UP";
    log("[order:status]", `Order ${order.id} -> PICKED_UP`);
    try { await updateOrderStatus(order, "PICKED_UP"); } catch (e) {}

    await notifyCustomer(order,
      `✅ *ORDER PICKED UP*\n\n🆔 Order: ${order.id}\n\nThank you for ordering from ${STORE_NAME}! ❤️\nEnjoy your meal! 🍛`,
      from
    );
    return sendWhatsAppText(from, `📦 Order ${order.id} marked as *PICKED UP*.`);
  }

  return sendWhatsAppText(from, "Unknown staff action.");
}

async function handleCustomerCancellation(from, orderId) {
  log("[customer]", `${from} wants to cancel order ${orderId}`);
  const order = Array.from(orders.values()).find(
    item => item.id.toLowerCase() === orderId.toLowerCase() && item.customerPhone === from
  );

  if (!order) {
    return sendWhatsAppText(from, `❌ Order ${orderId} not found under your number.`);
  }

  if (order.status === "CANCELLED") {
    return sendWhatsAppText(from, `Order ${order.id} is already cancelled.`);
  }

  if (order.status !== "NEW" && order.status !== "PREPARING") {
    return sendWhatsAppText(from,
      `⚠️ Order ${order.id} cannot be cancelled through the bot because it is already *${order.status.replace(/_/g, " ")}*.\n\nPlease call our ${BRANCH_NAME} branch directly.`
    );
  }

  order.status = "CANCELLED";
  order.cancelledBy = "customer";
  order.cancelledAt = new Date().toISOString();
  log("[order:status]", `Order ${order.id} -> CANCELLED by customer`);

  try {
    await updateOrderStatus(order, "CANCELLED");
  } catch (err) {
    logError(`[order:status] Supabase cancel for ${order.id}`, err);
  }

  if (BRANCH_NUMBER) {
    await sendWhatsAppText(normalizePhone(BRANCH_NUMBER),
      `❌ *ORDER CANCELLED BY CUSTOMER*

🆔 Order: ${order.id}
📱 Customer: ${customerLabel(order)}
🍽️ Food: ${order.food}
💵 Total: ${money(order.total)}
━━━━━━━━━━━━━━

Please STOP preparing this order.`
    ).catch(() => {});
  }

  return sendWhatsAppText(from,
    `❌ *ORDER CANCELLED*\n\n🆔 ${order.id}\n\nYour order has been cancelled and the kitchen was notified.\n\nReply *hi* whenever you want to order again.`
  );
}

/*--------------------------------------------------------------------------
 REPORTS
--------------------------------------------------------------------------*/
async function showReportOptions(to) {
  const session = getSession(to);
  session.step = "REPORT_PERIOD";
  const message = `📊 *${BRANCH_NAME.toUpperCase()} SALES REPORT*

Which period would you like?
1️⃣ *Daily*
2️⃣ *Weekly*
3️⃣ *Monthly*

_(Reply with *1*, *2*, or *3*, or type "daily", "weekly", "monthly")_`;
  return sendWhatsAppText(to, message);
}

async function sendBranchReport(to, period) {
  log("[report]", `Generating ${period} report for ${BRANCH_NAME}, requested by ${to}`);
  try {
    const reportOrders = await getOrders(BRANCH_NAME, period, orders);
    log("[report]", `${reportOrders.length} order(s) found for ${period}`);
    const pdf = await createReportPdf(BRANCH_NAME, period, reportOrders);
    const filename = `sweet-bite-${BRANCH_NAME.toLowerCase()}-${period}.pdf`;

    const cancelledCount = reportOrders.filter(o => String(o.status || "").toUpperCase() === "CANCELLED").length;
    await sendWhatsAppText(to,
      `📊 *${period.toUpperCase()} REPORT* for ${BRANCH_NAME}:\n• Total Orders: ${reportOrders.length}${cancelledCount ? ` (${cancelledCount} cancelled)` : ""}\n\nGenerating PDF report below...`
    );
    return sendWhatsAppDocument(to, pdf, filename, `${BRANCH_NAME} ${period} order report`);
  } catch (error) {
    logError(`[report] ${BRANCH_NAME} ${period} for ${to}`, error);
    return sendWhatsAppText(to, "❌ Could not generate the report. Please try again in a moment.");
  }
}

/*--------------------------------------------------------------------------
 INCOMING MESSAGE PARSER & STATE MACHINE
--------------------------------------------------------------------------*/
async function handleIncomingText(from, rawText, customerName) {
  const input = String(rawText || "").trim();
  const lower = input.toLowerCase();
  const isStaff = isBranchPhone(from);

  log("[text]", `${from}${isStaff ? " (STAFF)" : ""}${customerName ? ` (${customerName})` : ""} :: "${input}"`);

  const session = getSession(from);
  if (customerName) session.customerName = customerName;

  // 1. Staff Commands
  if (isStaff) {
    if (lower === "report") {
      return showReportOptions(from);
    }

    if (session.step === "REPORT_PERIOD") {
      let chosenPeriod = null;
      if (input === "1" || lower.includes("day") || lower.includes("daily")) chosenPeriod = "daily";
      else if (input === "2" || lower.includes("week")) chosenPeriod = "weekly";
      else if (input === "3" || lower.includes("month")) chosenPeriod = "monthly";

      if (chosenPeriod) {
        session.step = "WELCOME";
        return sendBranchReport(from, chosenPeriod);
      }
    }

    const staffMatch = input.match(/^(prepare|ready|rider|pickup)\s+([a-zA-Z0-9\-]+)$/i);
    if (staffMatch) {
      const action = staffMatch[1].toLowerCase();
      const orderId = staffMatch[2];
      return handleStaffAction(from, action, orderId);
    }
  }

  // 2. Global Resets & Greetings
  if (["hi", "hello", "hey", "start", "menu"].includes(lower)) {
    resetSession(from);
    return showWelcome(from);
  }

  if (["cancel", "restart"].includes(lower)) {
    resetSession(from);
    return sendWhatsAppText(from, "🔄 Current ordering process reset.\n\nReply *hi* to start a new order.");
  }

  // 3. Customer cancel of existing placed order
  const cancelMatch = input.match(/^cancel\s+([a-zA-Z0-9\-]+)$/i);
  if (cancelMatch) {
    return handleCustomerCancellation(from, cancelMatch[1]);
  }

  // 4. Ordering State Machine
  // Step: WELCOME / FOOD SELECTION
  if (session.step === "WELCOME") {
    if (input === "1" || lower.includes("jollof")) {
      session.food = "Jollof Rice";
      session.step = "PRICE";
      return showPriceOptions(from, session.food);
    }
    if (input === "2" || lower.includes("fried")) {
      session.food = "Fried Rice";
      session.step = "PRICE";
      return showPriceOptions(from, session.food);
    }
    return sendWhatsAppText(from,
      `Please choose what you would like to eat:\n1️⃣ *Jollof Rice*\n2️⃣ *Fried Rice*\n\n_(Reply with *1* or *2*)_`
    );
  }

  // Step: PRICE SELECTION
  if (session.step === "PRICE") {
    let selectedPortion = null;
    if (input === "1" || input === "30") selectedPortion = RICE_PORTIONS.find(p => p.amount === 30);
    else if (input === "2" || input === "40") selectedPortion = RICE_PORTIONS.find(p => p.amount === 40);
    else if (input === "3" || input === "50") selectedPortion = RICE_PORTIONS.find(p => p.amount === 50);
    else if (input === "4" || input === "60") selectedPortion = RICE_PORTIONS.find(p => p.amount === 60);

    if (selectedPortion) {
      session.foodAmount = selectedPortion.amount;
      session.includedChicken = selectedPortion.chicken;
      session.step = "FULFILLMENT";
      return showFulfillmentOptions(from);
    }

    return sendWhatsAppText(from,
      `Please choose a valid price option:\n1️⃣ ₵30 (1 chicken)\n2️⃣ ₵40 (1 chicken)\n3️⃣ ₵50 (2 chicken)\n4️⃣ ₵60 (3 chicken)\n\n_(Reply with 1, 2, 3, or 4)_`
    );
  }

  // Step: FULFILLMENT SELECTION (Pickup vs Delivery)
  if (session.step === "FULFILLMENT") {
    if (input === "1" || lower.includes("pick")) {
      session.fulfillment = "pickup";
      session.address = null;
      session.step = "CONFIRMATION";
      return sendOrderConfirmation(from, session);
    }
    if (input === "2" || lower.includes("deliv")) {
      session.fulfillment = "delivery";
      session.step = "ADDRESS";
      return sendWhatsAppText(from,
        `🚚 *DELIVERY SELECTED*\n\n💵 Payment is *ON DELIVERY*.\n\nPlease reply with your full delivery address:\n(e.g., Area, House number / Landmark)`
      );
    }
    return sendWhatsAppText(from,
      `Please choose how to receive your food:\n1️⃣ *Pick Up*\n2️⃣ *Delivery*\n\n_(Reply with *1* or *2*)_`
    );
  }

  // Step: ADDRESS INPUT
  if (session.step === "ADDRESS") {
    session.address = input;
    session.step = "CONFIRMATION";
    return sendOrderConfirmation(from, session);
  }

  // Step: ORDER CONFIRMATION
  if (session.step === "CONFIRMATION") {
    if (input === "1" || lower.includes("yes") || lower.includes("confirm") || lower.includes("place")) {
      return placeCustomerOrder(from, session);
    }
    if (input === "2" || lower.includes("no") || lower.includes("cancel")) {
      resetSession(from);
      return sendWhatsAppText(from, "❌ Order cancelled.\n\nReply *hi* whenever you want to order again.");
    }
    return sendWhatsAppText(from,
      `Would you like to place this order?\n1️⃣ *Yes, Place Order*\n2️⃣ *Cancel*\n\n_(Reply with *1* or *2*)_`
    );
  }

  // Fallback
  return sendWhatsAppText(from,
    `👋 Hello! Send *hi* to see our menu and place an order.`
  );
}

/*--------------------------------------------------------------------------
 DASHBOARD & API ROUTES
--------------------------------------------------------------------------*/
app.get("/", (req, res) => {
  if (req.query.format === "json" || (req.headers.accept && req.headers.accept.includes("application/json") && !req.headers.accept.includes("text/html"))) {
    return res.json({ ok: true, store: STORE_NAME, service: "Sweet Bite Food Ordering Bot (Baileys)", branch: BRANCH_NAME });
  }
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  sessions: sessions.size,
  orders: orders.size,
  branch: BRANCH_NAME,
  whatsappConnected: isBaileysConnected
}));

app.get("/orders", (req, res) => res.json(Array.from(orders.values())));

// Activity stream for live dashboard
app.get("/api/activities", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 250);
  const type = req.query.type;
  let filtered = activities;
  if (type && type !== "all") {
    filtered = activities.filter(a => a.type === type || (type === "error" && a.isError));
  }
  res.json({
    ok: true,
    total: activities.length,
    activities: filtered.slice(0, limit)
  });
});

// Overview stats & WhatsApp connection status
app.get("/api/stats", (req, res) => {
  const allOrders = Array.from(orders.values());
  const activeOrders = allOrders.filter(o => String(o.status || "").toUpperCase() !== "CANCELLED");
  const totalRevenue = activeOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);

  res.json({
    ok: true,
    store: STORE_NAME,
    branch: BRANCH_NAME,
    branchNumber: BRANCH_NUMBER || null,
    uptime: process.uptime(),
    sessionsCount: sessions.size,
    ordersCount: allOrders.length,
    activeOrdersCount: activeOrders.length,
    totalRevenue,
    activitiesCount: activities.length,
    supabaseConfigured: !!process.env.SUPABASE_URL,
    whatsappConfigured: true,
    whatsappConnected: isBaileysConnected,
    whatsappUser: connectedUser,
    hasQrCode: !!currentQr,
    qrCodeDataUrl: currentQrDataUrl
  });
});

// Endpoint to retrieve active QR code image/data
app.get("/api/baileys/qr", (req, res) => {
  res.json({
    connected: isBaileysConnected,
    user: connectedUser,
    hasQr: !!currentQr,
    qrDataUrl: currentQrDataUrl
  });
});

// Update order status from dashboard staff controls
app.post("/api/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, action } = req.body;
  const order = Array.from(orders.values()).find(item => item.id.toLowerCase() === id.toLowerCase());
  if (!order) return res.status(404).json({ error: `Order ${id} not found` });

  if (status === "CANCELLED" || action === "cancel") {
    order.status = "CANCELLED";
    order.cancelledBy = "dashboard_staff";
    order.cancelledAt = new Date().toISOString();
    log("[staff]", `Dashboard staff cancelled order ${id}`);
    try {
      await updateOrderStatus(order, "CANCELLED");
    } catch (e) {
      logError("[staff:cancel]", e);
    }
    return res.json({ ok: true, order });
  }

  const validAction = action || (
    status === "PREPARING" ? "prepare" :
    status === "READY" ? "ready" :
    status === "OUT_FOR_DELIVERY" ? "rider" :
    status === "PICKED_UP" ? "pickup" :
    null
  );

  if (validAction) {
    try {
      await handleStaffAction("dashboard_staff", validAction, id);
      const updated = Array.from(orders.values()).find(item => item.id.toLowerCase() === id.toLowerCase());
      return res.json({ ok: true, order: updated });
    } catch (err) {
      logError("[staff:action]", err);
      return res.status(500).json({ error: "Failed to perform staff action" });
    }
  }

  return res.status(400).json({ error: "Invalid status or action provided" });
});

// Simulator endpoint: allow sending simulated WhatsApp interactions & orders
app.post("/api/simulate", async (req, res) => {
  const {
    action,
    phone = "233241882200",
    text = "hi",
    customerName = "Kofi Mensah",
    food = "Jollof Rice",
    amount = 40,
    chicken = 1,
    fulfillment = "delivery",
    address = "Lapaz Station Road, Flat 3B"
  } = req.body;

  try {
    if (action === "text") {
      log("[simulate:text]", `Simulated message from ${customerName} (+${phone}): "${text}"`);
      await handleIncomingText(phone, text, customerName);
      return res.json({ ok: true, message: `Processed simulated message: "${text}"` });
    }

    if (action === "order") {
      const simSession = {
        step: "CONFIRMATION",
        food,
        foodAmount: amount,
        includedChicken: chicken,
        fulfillment,
        address: fulfillment === "delivery" ? address : null,
        customerName
      };
      log("[simulate:order]", `Simulated order: ${food} (${money(amount)}) for ${customerName}`);
      await placeCustomerOrder(phone, simSession);
      return res.json({ ok: true, message: "Simulated order placed successfully!", order: simSession.order });
    }

    return res.status(400).json({ error: "Unknown simulation action (expected 'text' or 'order')" });
  } catch (error) {
    logError("[simulate]", error);
    return res.status(500).json({ error: error.message });
  }
});

// PDF Report download directly from dashboard
app.get("/api/reports/download", async (req, res) => {
  try {
    const period = ["daily", "weekly", "monthly"].includes(req.query.period) ? req.query.period : "daily";
    const reportOrders = await getOrders(BRANCH_NAME, period, orders);
    const pdfBuffer = await createReportPdf(BRANCH_NAME, period, reportOrders);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="sweet-bite-${BRANCH_NAME.toLowerCase()}-${period}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    logError("[report:download]", error);
    res.status(500).json({ error: "Failed to generate report PDF" });
  }
});

/*--------------------------------------------------------------------------
 START SERVER & INITIALIZE BAILEYS
--------------------------------------------------------------------------*/
app.listen(PORT, "0.0.0.0", () => {
  log("[boot]", `🍛 ${STORE_NAME} food bot running on port ${PORT}`);
  log("[boot]", `Engine: Baileys Multi-Device (0 Meta API fees)`);
  log("[boot]", `Branch: ${BRANCH_NAME} (+${normalizePhone(BRANCH_NUMBER) || "NOT SET"})`);
  log("[boot]", `Supabase: ${process.env.SUPABASE_URL ? "configured" : "not configured (in-memory only)"}`);
  log("[boot]", `Dashboard: live at http://localhost:${PORT}/`);

  // Seed sample initial order for dashboard
  if (orders.size === 0) {
    const seedOrder = {
      id: "SB-01101830",
      customerPhone: "233244112233",
      customerName: "Akosua Addo",
      branch: BRANCH_NAME,
      food: "Jollof Rice",
      basePrice: 50,
      includedChicken: 2,
      total: 50,
      fulfillment: "delivery",
      address: "Lapaz Abrantie Junction, House #12",
      status: "PREPARING",
      createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString()
    };
    orders.set(seedOrder.id, seedOrder);
  }

  // Start WhatsApp Baileys client
  startBaileys();
});
