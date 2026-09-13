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

  ABEKA_BRANCH_NUMBER,
  FADAMA_BRANCH_NUMBER,
  TABORA_BRANCH_NUMBER,
  EAST_LEGON_BRANCH_NUMBER,
  GCTU_BRANCH_NUMBER,
  RACE_COARSE_BRANCH_NUMBER,

  STORE_NAME = "Juljones Food"
} = process.env;

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v23.0";

const WA_URL =
  `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

/*--------------------------------------------------------------------------
BRANCHES
--------------------------------------------------------------------------*/
const BRANCHES = {
  "Abeka": { number: ABEKA_BRANCH_NUMBER },
  "Fadama": { number: FADAMA_BRANCH_NUMBER },
  "Tabora": { number: TABORA_BRANCH_NUMBER },
  "GCTU": { number: GCTU_BRANCH_NUMBER },
  "Race Course": { number: RACE_COARSE_BRANCH_NUMBER }
};

/*--------------------------------------------------------------------------
 RICE / JOLLOF / PLAIN RICE — price includes free chicken
--------------------------------------------------------------------------*/
const RICE_PORTIONS = [
  { amount: 25, chicken: 1 },
  { amount: 30, chicken: 1 },
  { amount: 40, chicken: 1 },
  { amount: 50, chicken: 2 }
];

/*--------------------------------------------------------------------------
 BANKU / KOKONTE / RICE BALL — base food amount (₵5 - ₵50)
--------------------------------------------------------------------------*/
const LOCAL_FOOD_AMOUNTS = [];
for (let amount = 5; amount <= 50; amount += 5) {
  LOCAL_FOOD_AMOUNTS.push(amount);
}

/*--------------------------------------------------------------------------
 FUFU — base food amount (₵10 - ₵50)
--------------------------------------------------------------------------*/
const FUFU_AMOUNTS = [];
for (let amount = 10; amount <= 50; amount += 5) {
  FUFU_AMOUNTS.push(amount);
}

/*--------------------------------------------------------------------------
 WAAKYE — base food amount (₵10 - ₵50)
--------------------------------------------------------------------------*/
const WAAKYE_AMOUNTS = [];
for (let amount = 10; amount <= 50; amount += 5) {
  WAAKYE_AMOUNTS.push(amount);
}

/*--------------------------------------------------------------------------
 SOUPS — for Banku / Fufu / Kokonte / Rice Ball only. No price, just a choice.
--------------------------------------------------------------------------*/
const SOUPS = {
  soup_light:      { name: "Light Soup" },
  soup_okro:       { name: "Okro Stew" },
  soup_palmnut:    { name: "Palmnut Soup" },
  soup_groundnut:  { name: "Groundnut Soup" },
  soup_goat:   { name: "Goat soup" }
};

/*--------------------------------------------------------------------------
 WAAKYE ADD-ONS
--------------------------------------------------------------------------*/
const WAAKYE_ADDONS = {
  egg:       { name: "Egg",       price: 4,  emoji: "🥚" },
  meat:      { name: "Meat",      price: 20, emoji: "🍖" },
  wele:      { name: "Wele",      price: 10, emoji: "🐄" },
  gari:      { name: "Gari",      price: 5,  emoji: "🌾" },
  spaghetti: { name: "Spaghetti", price: 10, emoji: "🍝" },
  sausage:   { name: "Sausage",   price: 5,  emoji: "🌭" },
  fish:      { name: "Fish",      price: 10, emoji: "🐟" },
  salad:     { name: "Salad",     price: 5,  emoji: "🥗" }
};

/*--------------------------------------------------------------------------
 LOCAL FOOD PROTEINS — for Banku / Fufu / Kokonte / Rice Ball
--------------------------------------------------------------------------*/
const LOCAL_PROTEINS = {
  cow_meat:  { name: "Cow Meat",  price: 20, emoji: "🐄" },
  goat_meat: { name: "Goat Meat", price: 20, emoji: "🐐" },
  fish:      { name: "Fish",      price: 10, emoji: "🐟" },
  chicken:   { name: "Chicken",   price: 20, emoji: "🍗" },
  intestine: { name: "Intestine", price: 10, emoji: "🐄" },
  wele:      { name: "Wele",      price: 10, emoji: "🐄" },
  beef:      { name: "Beef",      price: 5,  emoji: "🥩" }
};

const LOCAL_FOODS = ["Fufu", "Banku", "Kokonte", "Rice Ball"];
const PLAIN_RICE_FOODS = ["Fried Rice", "Jollof Rice", "Plain Rice"];

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
      branch: null,
      food: null,
      foodAmount: null,
      soup: null,
      proteins: [],
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
    branch: null,
    food: null,
    foodAmount: null,
    soup: null,
    proteins: [],
    includedChicken: 0,
    fulfillment: null,
    address: null,
    order: null
  });
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
 BRANCH LIST
--------------------------------------------------------------------------*/
function branchRows() {
  return Object.keys(BRANCHES).map((branch, index) => ({
    id: `branch_${index}`,
    title: branch,
    description: "Choose this branch"
  }));
}

function getBranchFromId(id) {
  const branches = Object.keys(BRANCHES);
  const index = Number(String(id).replace("branch_", ""));
  return branches[index];
}

function getBranchForPhone(phone) {
  const normalized = normalizePhone(phone);
  return Object.entries(BRANCHES)
    .find(([, branch]) => normalizePhone(branch.number) === normalized)?.[0] || null;
}

/*--------------------------------------------------------------------------
 FOOD LIST
--------------------------------------------------------------------------*/
function foodRows() {
  return [
    { id: "food_fried_rice", title: "Fried Rice",  description: "₵25 - ₵50" },
    { id: "food_jollof",     title: "Jollof Rice", description: "₵25 - ₵50" },
    { id: "food_plain_rice", title: "Plain Rice",  description: "₵25 - ₵50" },
    { id: "food_waakye",     title: "Waakye",       description: "₵10 - ₵50" },
    { id: "food_fufu",       title: "Fufu",         description: "₵10 - ₵50 · Choose soup & protein" },
    { id: "food_banku",      title: "Banku",        description: "₵5 - ₵50 · Choose soup & protein" },
    { id: "food_kokonte",    title: "Kokonte",       description: "₵5 - ₵50 · Choose soup & protein" },
    { id: "food_rice_ball",  title: "Rice Ball",    description: "₵5 - ₵50 · Choose soup & protein" }
  ];
}

/*--------------------------------------------------------------------------
 RICE AMOUNTS (includes free chicken)
--------------------------------------------------------------------------*/
function riceAmountRows() {
  return RICE_PORTIONS.map(portion => ({
    id: `riceamt_${portion.amount}`,
    title: money(portion.amount),
    description: `Includes ${portion.chicken} chicken`
  }));
}

/*--------------------------------------------------------------------------
 LOCAL FOOD AMOUNTS (Banku / Kokonte / Rice Ball)
--------------------------------------------------------------------------*/
function localFoodAmountRows() {
  return LOCAL_FOOD_AMOUNTS.map(amount => ({
    id: `amount_${amount}`,
    title: money(amount),
    description: "Base food amount"
  }));
}

/*--------------------------------------------------------------------------
 FUFU AMOUNTS
--------------------------------------------------------------------------*/
function fufuAmountRows() {
  return FUFU_AMOUNTS.map(amount => ({
    id: `amount_${amount}`,
    title: money(amount),
    description: "Base food amount"
  }));
}

/*--------------------------------------------------------------------------
 WAAKYE AMOUNTS
--------------------------------------------------------------------------*/
function waakyeAmountRows() {
  return WAAKYE_AMOUNTS.map(amount => ({
    id: `waakyeamt_${amount}`,
    title: money(amount),
    description: "Base food amount"
  }));
}

/*--------------------------------------------------------------------------
 SOUP SELECTION
--------------------------------------------------------------------------*/
function soupRows() {
  return Object.entries(SOUPS).map(([id, item]) => ({
    id,
    title: item.name,
    description: "Choose this soup"
  }));
}

/*--------------------------------------------------------------------------
 GENERIC ITEM (protein / add-on) ROWS — catalog-driven
--------------------------------------------------------------------------*/
function itemRows(catalog) {
  return Object.entries(catalog).map(([id, item]) => ({
    id: `item_${id}`,
    title: `${item.name} — ${money(item.price)}`,
    description: "Tap to add"
  }));
}

/*--------------------------------------------------------------------------
 CATALOG RESOLUTION — which protein/add-on list applies to the current food
--------------------------------------------------------------------------*/
function getCatalogForSession(session) {
  if (session.food === "Waakye") return WAAKYE_ADDONS;
  if (LOCAL_FOODS.includes(session.food)) return LOCAL_PROTEINS;
  return null; // Fried Rice / Jollof Rice / Plain Rice — no protein/add-on catalog
}

/*--------------------------------------------------------------------------
 CALCULATE TOTAL
--------------------------------------------------------------------------*/
function getBaseFoodPrice(session) {
  return Number(session.foodAmount) || 0;
}

function getProteinTotal(session) {
  const catalog = getCatalogForSession(session);
  if (!catalog) return 0;
  return session.proteins.reduce((total, itemId) => {
    const item = catalog[itemId];
    return total + (item ? item.price : 0);
  }, 0);
}

function calculateTotal(session) {
  return getBaseFoodPrice(session) + getProteinTotal(session);
}

/*--------------------------------------------------------------------------
 PROTEIN / ADD-ON SUMMARY
--------------------------------------------------------------------------*/
function proteinSummary(session) {
  const catalog = getCatalogForSession(session);
  if (!catalog || !session.proteins.length) return "";

  const counts = {};
  session.proteins.forEach(itemId => {
    counts[itemId] = (counts[itemId] || 0) + 1;
  });

  return Object.entries(counts)
    .map(([itemId, quantity]) => {
      const item = catalog[itemId];
      if (!item) return null;
      return `${item.emoji} ${item.name} x${quantity} — ${money(item.price * quantity)}`;
    })
    .filter(Boolean)
    .join("\n");
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

  return `JJ-${day}${month}${hour}${minutes}`;
}

/*--------------------------------------------------------------------------
 ORDER SUMMARY
--------------------------------------------------------------------------*/
function buildOrderSummary(session) {
  const basePrice = getBaseFoodPrice(session);
  const soupLine = session.soup ? `🥣 Soup: ${SOUPS[session.soup]?.name || session.soup}\n` : "";
  const chickenLine = session.includedChicken ? `🍗 Includes ${session.includedChicken} chicken\n` : "";
  const extras = `${chickenLine}${soupLine}${proteinSummary(session)}`;
  return `🛍️ *${STORE_NAME.toUpperCase()} ORDER*

📍 Branch: ${session.branch}
🍽️ Food: ${session.food}
💰 Food amount: ${money(basePrice)}
${extras}${extras ? "\n" : ""}
━━━━━━━━━━━━━━

💵 *TOTAL: ${money(calculateTotal(session))}*
🚚 Method: ${session.fulfillment === "pickup" ? "Pick Up" : "Delivery — Pay on Delivery"} ${session.fulfillment === "delivery" ? `\n📍 Address:\n${session.address}` : ""}`;
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
  const branch = BRANCHES[order.branch];
  if (!branch || !branch.number) {
    console.error(`No WhatsApp number configured for ${order.branch}`);
    return false;
  }

  const soupLine = order.soup ? `🥣 Soup: ${SOUPS[order.soup]?.name || order.soup}\n` : "";
  const chickenLine = order.includedChicken ? `🍗 Includes ${order.includedChicken} chicken\n` : "";
  const extras = `${chickenLine}${soupLine}${order.proteinSummary}`.trim();

  const message = `🔔 *NEW ORDER*

🆔 Order: ${order.id}
📍 Branch: ${order.branch}
📱 Customer: ${order.customerPhone}
🍽️ Food: ${order.food}
💰 Food: ${money(order.basePrice)}${extras ? `\n${extras}` : ""}
━━━━━━━━━━━━━

💵 *TOTAL: ${money(order.total)}*
🚚 Method: ${order.fulfillment === "pickup" ? "PICK UP" : "DELIVERY — PAY ON DELIVERY"} ${order.fulfillment === "delivery" ? `\n📍 DELIVERY ADDRESS:\n${order.address}` : ""}
━━━━━━━━━━━━━━

Please start preparing this order.`;

  await sendWhatsAppText(normalizePhone(branch.number), message);

  await sendButtons(normalizePhone(branch.number),
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
Enjoy delicious local food from Juljones Food.

🍚 Fried Rice
🍚 Jollof Rice
🍚 Plain Rice
🍛 Waakye
🍚 Rice Ball
🍲 Fufu
🍲 Banku
🍲 Kokonte

📍 First, choose the branch closest to you.`;

  await sendWhatsAppText(to, message);
  return sendInteractiveList(to,
    "📍 Which Juljones branch would you like to order from?",
    "Branches",
    branchRows()
  );
}

/*--------------------------------------------------------------------------
 HANDLE TEXT
--------------------------------------------------------------------------*/
async function showReportOptions(to, branch) {
  const session = getSession(to);
  session.reportBranch = branch;
  session.step = "REPORT_PERIOD";
  return sendButtons(to,
    `📊 *${branch.toUpperCase()} REPORT*\n\nWhich report would you like?`,
    [
      { id: "report_daily", title: "Daily" },
      { id: "report_weekly", title: "Weekly" },
      { id: "report_monthly", title: "Monthly" }
    ]
  );
}

async function sendBranchReport(to, branch, period) {
  try {
    const reportOrders = await getOrders(branch, period, orders);
    const pdf = await createReportPdf(branch, period, reportOrders);
    const filename = `juljones-${branch.toLowerCase().replace(/\s+/g, "-")}-${period}.pdf`;

    await sendWhatsAppText(to,
      `📊 ${period[0].toUpperCase() + period.slice(1)} report for ${branch}: ${reportOrders.length} order(s).`
    );
    return sendWhatsAppDocument(to, pdf, filename, `${branch} ${period} order report`);
  } catch (error) {
    console.error("REPORT ERROR:", error.response?.data || error.message);
    return sendWhatsAppText(to,
      "❌ I could not generate the report right now. Please try again in a moment."
    );
  }
}

async function handleText(from, text) {
  const input = String(text || "").trim();
  const lower = input.toLowerCase();
  const branch = getBranchForPhone(from);

  if (branch && lower === "report") return showReportOptions(from, branch);

  const session = getSession(from);
  if (branch && session.step === "REPORT_PERIOD" && ["daily", "weekly", "monthly"].includes(lower)) {
    session.step = "WELCOME";
    return sendBranchReport(from, branch, lower);
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

  if (id.startsWith("report_")) {
    const period = id.replace("report_", "");
    const branch = getBranchForPhone(from);
    if (branch && session.step === "REPORT_PERIOD" && ["daily", "weekly", "monthly"].includes(period)) {
      session.step = "WELCOME";
      return sendBranchReport(from, branch, period);
    }
    return;
  }

  /*-- BRANCH --*/
  if (id.startsWith("branch_")) {
    const branch = getBranchFromId(id);
    if (!branch) return;
    session.branch = branch;
    session.step = "FOOD";
    return sendInteractiveList(from,
      `📍 *${branch} BRANCH SELECTED*\n\nWhat would you like to eat?`,
      "Food Menu",
      foodRows()
    );
  }

  /*-- FOOD MENU --*/
  if (id.startsWith("food_")) {
    const foodMap = {
      food_fried_rice: "Fried Rice",
      food_jollof:     "Jollof Rice",
      food_plain_rice: "Plain Rice",
      food_waakye:     "Waakye",
      food_fufu:       "Fufu",
      food_banku:      "Banku",
      food_kokonte:    "Kokonte",
      food_rice_ball:  "Rice Ball"
    };

    const food = foodMap[id];
    if (!food) return;

    session.food = food;
    session.foodAmount = null;
    session.soup = null;
    session.proteins = [];
    session.includedChicken = 0;

    // Plain rice: Fried Rice / Jollof Rice / Plain Rice — just a price, no protein
    if (PLAIN_RICE_FOODS.includes(food)) {
      session.step = "RICE_AMOUNT";
      return sendInteractiveList(from,
        `🍚 *${food}*\n\nChoose your price:`,
        "Portions",
        riceAmountRows()
      );
    }

    // Waakye: choose base amount first, then add-ons
    if (food === "Waakye") {
      session.step = "WAAKYE_AMOUNT";
      return sendInteractiveList(from,
        `🍛 *Waakye*\n\nChoose the amount of food you want.\n\nYou can select any amount from ₵10 to ₵50.`,
        "Food Amount",
        waakyeAmountRows()
      );
    }

    // Fufu: base amount ₵10 - ₵50, then soup → protein
    if (food === "Fufu") {
      session.step = "LOCAL_AMOUNT";
      return sendInteractiveList(from,
        `🍲 *${food}*\n\nChoose the amount of food you want.\n\nYou can select any amount from ₵10 to ₵50.`,
        "Food Amount",
        fufuAmountRows()
      );
    }

    // Local foods (Banku / Kokonte / Rice Ball): amount → soup → protein
    session.step = "LOCAL_AMOUNT";
    return sendInteractiveList(from,
      `🍲 *${food}*\n\nChoose the amount of food you want.\n\nYou can select any amount from ₵5 to ₵50.`,
      "Food Amount",
      localFoodAmountRows()
    );
  }

  /*-- PLAIN RICE AMOUNT (includes free chicken) --*/
  if (id.startsWith("riceamt_")) {
    const amount = Number(id.replace("riceamt_", ""));
    const portion = RICE_PORTIONS.find(item => item.amount === amount);
    if (!portion) return;

    session.foodAmount = portion.amount;
    session.includedChicken = portion.chicken;
    session.step = "FULFILLMENT";
    return showFulfillmentOptions(from);
  }

  /*-- WAAKYE AMOUNT --*/
  if (id.startsWith("waakyeamt_")) {
    const amount = Number(id.replace("waakyeamt_", ""));
    if (!WAAKYE_AMOUNTS.includes(amount)) return;

    session.foodAmount = amount;
    session.proteins = [];
    session.step = "PROTEIN";
    return sendInteractiveList(from,
      `Waakye: ${money(amount)}\n\nNow choose your add-ons (you can add more than one):`,
      "Add-ons",
      itemRows(WAAKYE_ADDONS)
    );
  }

  /*-- LOCAL FOOD AMOUNT (Fufu / Banku / Kokonte / Rice Ball) --*/
  if (id.startsWith("amount_")) {
    const amount = Number(id.replace("amount_", ""));
    const validAmounts = session.food === "Fufu" ? FUFU_AMOUNTS : LOCAL_FOOD_AMOUNTS;
    if (!validAmounts.includes(amount)) return;

    session.foodAmount = amount;
    session.step = "SOUP";
    return sendInteractiveList(from,
      `${session.food}: ${money(amount)}\n\nNow choose your soup:`,
      "Soup",
      soupRows()
    );
  }

  /*-- SOUP SELECTION --*/
  if (id in SOUPS) {
    session.soup = id;
    session.proteins = [];
    session.step = "PROTEIN";
    return sendInteractiveList(from,
      `🥣 ${SOUPS[id].name} selected.\n\nNow choose your protein:`,
      "Protein",
      itemRows(LOCAL_PROTEINS)
    );
  }

  /*-- PROTEIN / ADD-ON SELECTION --*/
  if (id.startsWith("item_")) {
    const catalog = getCatalogForSession(session);
    const itemId = id.replace("item_", "");
    if (!catalog || !catalog[itemId]) return;

    session.proteins.push(itemId);
    const item = catalog[itemId];

    await sendWhatsAppText(from,
      `✅ ${item.emoji} ${item.name} added — ${money(item.price)}\n\nCurrent total: ${money(calculateTotal(session))}`
    );

    return sendButtons(from,
      "Would you like to add another protein/add-on?",
      [
        { id: "add_more_protein", title: "➕ Add More" },
        { id: "done_protein",     title: "✅ Done"     }
      ]
    );
  }

  /*-- ADD MORE PROTEIN --*/
  if (id === "add_more_protein") {
    const catalog = getCatalogForSession(session);
    if (!catalog) return;
    session.step = "PROTEIN";
    return sendInteractiveList(from, "Choose another protein/add-on:", "Protein", itemRows(catalog));
  }

  /*-- DONE PROTEIN --*/
  if (id === "done_protein") {
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
 FULFILLMENT OPTIONS
--------------------------------------------------------------------------*/
async function showFulfillmentOptions(to) {
  return sendInteractiveList(to,
    "🚚 How would you like to receive your food?",
    "Order Method",
    [
      { id: "pickup",   title: "Pick Up",  description: "Come to the selected branch" },
      { id: "delivery", title: "Delivery", description: "Pay the rider on delivery"   }
    ]
  );
}

/*--------------------------------------------------------------------------
 PLACE ORDER
--------------------------------------------------------------------------*/
async function placeCustomerOrder(from, session) {
  const order = {
    id:            generateOrderId(),
    customerPhone: from,
    branch:        session.branch,
    food:          session.food,
    basePrice:     getBaseFoodPrice(session),
    soup:          session.soup || null,
    includedChicken: session.includedChicken || 0,
    proteins:      [...session.proteins],
    proteinSummary: proteinSummary(session),
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
      `❌ We couldn't send your order to the ${order.branch} branch.\n\nPlease try again later or send *hi* to restart.`
    );
  }

  const soupLine = order.soup ? `🥣 Soup: ${SOUPS[order.soup]?.name || order.soup}\n` : "";
  const chickenLine = order.includedChicken ? `🍗 Includes ${order.includedChicken} chicken\n` : "";
  const addressLine = order.fulfillment === "delivery"
    ? `\n📍 Address: ${order.address}`
    : "";
  const extras = `${chickenLine}${soupLine}${order.proteinSummary}`;

  await sendWhatsAppText(from,
    `🎉 *ORDER PLACED SUCCESSFULLY!*

🆔 Order: ${order.id}
📍 Branch: ${order.branch}
🍽️ Food: ${order.food}
${extras}${extras ? "\n" : ""}
💵 Total: ${money(order.total)}
🚚 Method: ${order.fulfillment === "pickup" ? "Pick Up" : "Delivery — Pay on Delivery"}${addressLine}
━━━━━━━━━━━━━━

Your order has been sent to the branch.
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
        `🎉 *YOUR FOOD IS READY!*\n\n🆔 Order: ${order.id}\n📍 Branch: ${order.branch}\n🍽️ ${order.food}\n\nYour food is ready for pickup. 🍛\n\nYou can come to the branch and collect your order.\n\nThank you for ordering from ${STORE_NAME}! ❤️`
      );
    } else {
      await sendWhatsAppText(order.customerPhone,
        `🎉 *YOUR FOOD IS READY!*\n\n🆔 Order: ${order.id}\n📍 Branch: ${order.branch}\n🍽️ ${order.food}\n\nYour food has been prepared and is ready for delivery.\n\n🚚 Your rider will be on the way shortly.\n\n💵 Please remember: *PAY ON DELIVERY*.`
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
      `🚴 *YOUR RIDER IS ON THE WAY!*\n\n🆔 Order: ${order.id}\n📍 Branch: ${order.branch}\n\nYour food is on the way.\n\n💵 Payment: *PAY ON DELIVERY*\n\nPlease keep your phone available.\n\nThank you for ordering from ${STORE_NAME}! ❤️`
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
app.get("/",       (req, res) => res.json({ ok: true, store: STORE_NAME, service: "Juljones Food Ordering Bot" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime(), sessions: sessions.size, orders: orders.size, branches: Object.keys(BRANCHES) }));
app.get("/orders", (req, res) => res.json(Array.from(orders.values())));

/*--------------------------------------------------------------------------
 START
--------------------------------------------------------------------------*/
app.listen(PORT, () => {
  console.log(`🍛 ${STORE_NAME} food bot running on port ${PORT}`);
  console.log("Branches:", Object.keys(BRANCHES));
});