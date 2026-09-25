const PDFDocument = require("pdfkit");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ➕ ADDED: small logger shared by this file, same style/format as sweetbite-bot.js
function ts() { return new Date().toISOString().slice(11, 19); }
function log(tag, ...args) { console.log(`[${ts()}] ${tag}`, ...args); }
function logError(tag, error) { console.error(`[${ts()}] ${tag} ❌`, error?.message || error); }
if (!supabase) log("[reports]", "Supabase not configured — reports will use in-memory orders only (lost on restart)."); // ➕ ADDED

function getPeriodRange(period, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (period === "weekly") {
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
  }
  if (period === "monthly") start.setDate(1);

  const end = new Date(start);
  if (period === "daily") end.setDate(end.getDate() + 1);
  if (period === "weekly") end.setDate(end.getDate() + 7);
  if (period === "monthly") end.setMonth(end.getMonth() + 1);

  return { start, end };
}

function isInRange(order, range) {
  const createdAt = new Date(order.createdAt);
  return createdAt >= range.start && createdAt < range.end;
}

// ➕ ADDED: single place that decides whether an order counts as cancelled
function isCancelled(order) {
  return String(order?.status || "").trim().toUpperCase() === "CANCELLED";
}

async function saveOrder(order) {
  if (!supabase) { log("[reports:save]", `Skipped (no Supabase) for order ${order.id}`); return; } // ➕ ADDED
  const { error } = await supabase.from("orders").insert({
    id: order.id,
    branch: order.branch,
    customer_phone: order.customerPhone,
    food: order.food,
    base_price: order.basePrice,
    soup: order.soup,
    included_chicken: order.includedChicken,
    proteins: order.proteins,
    protein_summary: order.proteinSummary,
    total: order.total,
    fulfillment: order.fulfillment,
    address: order.address,
    status: order.status,
    created_at: order.createdAt
  });
  if (error) { logError(`[reports:save] ${order.id}`, error); throw error; } // ➕ CHANGED
  log("[reports:save]", `Order ${order.id} saved`); // ➕ ADDED
}

// ➕ ADDED: saves a status change (e.g. CANCELLED) so reports still show it after a restart.
// Matches on id AND created_at so two orders that share an id (same minute) are never mixed up.
async function updateOrderStatus(order, status) {
  if (!supabase) { log("[reports:status]", `Skipped (no Supabase) for order ${order.id} -> ${status}`); return; } // ➕ ADDED
  const { error } = await supabase
    .from("orders")
    .update({ status })
    .eq("id", order.id)
    .eq("created_at", order.createdAt);
  if (error) { logError(`[reports:status] ${order.id} -> ${status}`, error); throw error; } // ➕ CHANGED
  log("[reports:status]", `Order ${order.id} -> ${status} saved`); // ➕ ADDED
}

async function getOrders(branch, period, fallbackOrders) {
  const range = getPeriodRange(period);
  const localOrders = Array.from(fallbackOrders.values())
    .filter(order => order.branch === branch && isInRange(order, range));
  log("[reports:get]", `${branch} ${period}: ${localOrders.length} in-memory order(s), range ${range.start.toISOString()} - ${range.end.toISOString()}`); // ➕ ADDED

  if (!supabase) return localOrders;

  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("branch", branch)
    .gte("created_at", range.start.toISOString())
    .lt("created_at", range.end.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    logError(`[reports:get] ${branch} ${period}`, error); // ➕ CHANGED (was console.error)
    return localOrders;
  }
  log("[reports:get]", `${branch} ${period}: ${data.length} Supabase order(s) fetched`); // ➕ ADDED

  const storedOrders = data.map(order => ({
    ...order,
    customerPhone: order.customer_phone,
    basePrice: order.base_price,
    includedChicken: order.included_chicken,
    proteinSummary: order.protein_summary,
    fulfillment: order.fulfillment,
    createdAt: order.created_at
  }));

  // ➕ CHANGED: live (in-memory) orders now come FIRST so their newer status (e.g. CANCELLED)
  // wins over the older copy stored in Supabase.
  const combined = [...localOrders, ...storedOrders];
  const seen = new Set();
  const result = combined.filter(order => {
    // ➕ CHANGED: compare timestamps as numbers — Supabase returns "+00:00" while JS uses "Z",
    // so comparing the raw strings could show the same order twice.
    const key = `${order.id}|${new Date(order.createdAt).getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
  log("[reports:get]", `${branch} ${period}: returning ${result.length} order(s) after merge/de-dupe`); // ➕ ADDED
  return result;
}

function money(value) {
  return `GHS ${Number(value || 0).toFixed(2)}`;
}

function pdfSafeText(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, "");
}

/*--------------------------------------------------------------------------
 BRAND PALETTE — warm terracotta / amber, built for a food brand
--------------------------------------------------------------------------*/
const COLOR = {
  headerBg:       "#5C2A1A",
  headerAccent:   "#F3D9C4",
  cream:          "#FBF3EA",
  cardBorder:     "#EEDFCE",
  darkText:       "#3B2A20",
  mutedText:      "#8C7965",
  tableHeaderBg:  "#3B2A20",
  rowAlt:         "#FBF3EA",
  ruleColor:      "#E7D6C4",
  orders:         "#C2410C",
  sales:          "#B45309",
  average:        "#0F766E",
  pickupBg:       "#FEF3C7",
  pickupText:     "#92400E",
  deliveryBg:     "#FCE7E4",
  deliveryText:   "#9A3412",
  // ➕ ADDED: cancelled-order styling
  cancelledBg:    "#FEE2E2",
  cancelledText:  "#B91C1C",
  cancelledRow:   "#FDF0EF"
};

const PAGE_WIDTH  = 595;
const MARGIN      = 40;
const CONTENT_W   = PAGE_WIDTH - MARGIN * 2;

const COLUMNS = [
  { label: "ORDER ID", x: 40,  width: 78 },
  { label: "TIME",     x: 118, width: 46 },
  { label: "CUSTOMER", x: 164, width: 88 },
  { label: "DETAILS",  x: 252, width: 168 },
  { label: "METHOD",   x: 420, width: 62 },
  { label: "TOTAL",    x: 482, width: 73 }
];

function drawTableHeader(doc, y) {
  doc.save();
  doc.roundedRect(MARGIN, y, CONTENT_W, 26, 4).fill(COLOR.tableHeaderBg);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
  COLUMNS.forEach(column => doc.text(column.label, column.x + 8, y + 9, { width: column.width - 14 }));
  doc.restore();
}

function drawMethodPill(doc, method, x, y, width) {
  const isPickup = method === "pickup";
  const label = isPickup ? "Pick up" : "Delivery";
  const bg = isPickup ? COLOR.pickupBg : COLOR.deliveryBg;
  const fg = isPickup ? COLOR.pickupText : COLOR.deliveryText;
  const pillWidth = Math.min(width, doc.widthOfString(label) + 18);

  doc.save();
  doc.roundedRect(x, y, pillWidth, 16, 8).fill(bg);
  doc.fillColor(fg).font("Helvetica-Bold").fontSize(7.5).text(label, x, y + 4.5, { width: pillWidth, align: "center" });
  doc.restore();
}

// ➕ ADDED: small red "CANCELLED" tag shown under the order ID
function drawCancelledTag(doc, x, y) {
  const label = "CANCELLED";
  doc.save();
  doc.font("Helvetica-Bold").fontSize(6.5);
  const width = doc.widthOfString(label) + 12;
  doc.roundedRect(x, y, width, 12, 6).fill(COLOR.cancelledBg);
  doc.fillColor(COLOR.cancelledText).text(label, x, y + 3, { width, align: "center", lineBreak: false });
  doc.restore();
}

function drawFooter(doc, pageNumber) {
  const y = 776;
  doc.save();
  doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).lineWidth(0.5).strokeColor(COLOR.ruleColor).stroke();
  doc.fillColor(COLOR.mutedText).font("Helvetica").fontSize(8);
  doc.text("Sweet Bite - Confidential order report", MARGIN, y + 8, { width: 300, lineBreak: false });
  doc.text(`Page ${pageNumber}`, PAGE_WIDTH - MARGIN - 100, y + 8, { width: 100, align: "right", lineBreak: false });
  doc.restore();
}

function createReportPdf(branch, period, orders) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: "A4", bufferPages: true });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ➕ CHANGED: cancelled orders are listed in the table but NOT counted as sales
    const activeOrders    = orders.filter(order => !isCancelled(order));
    const cancelledOrders = orders.filter(order => isCancelled(order));
    const cancelledTotal  = cancelledOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);

    const total = activeOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const average = activeOrders.length ? total / activeOrders.length : 0;
    const periodLabel = `${period[0].toUpperCase()}${period.slice(1)}`;

    /*----------------------------- HEADER BAND -----------------------------*/
    doc.rect(0, 0, PAGE_WIDTH, 112).fill(COLOR.headerBg);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(24).text("SWEET BITE", MARGIN, 30);
    doc.fontSize(11).font("Helvetica").fillColor(COLOR.headerAccent).text("Order performance report", MARGIN, 62);

    const badgeText = `${branch.toUpperCase()}  ·  ${periodLabel.toUpperCase()}`;
    const badgeWidth = doc.widthOfString(badgeText) + 28;
    const badgeX = PAGE_WIDTH - MARGIN - badgeWidth;
    doc.save();
    doc.fillOpacity(0.16).roundedRect(badgeX, 34, badgeWidth, 24, 12).fill("#FFFFFF");
    doc.restore();
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9).text(badgeText, badgeX, 41, { width: badgeWidth, align: "center" });

    doc.fillColor(COLOR.darkText).font("Helvetica-Bold").fontSize(15).text(`${periodLabel} order report`, MARGIN, 128);
    doc.fillColor(COLOR.mutedText).font("Helvetica").fontSize(9).text(`Generated ${new Date().toLocaleString("en-GB")}`, MARGIN, 150);

    /*------------------------------ STAT CARDS -----------------------------*/
    const cards = [
      { label: "ORDERS",        value: String(activeOrders.length), color: COLOR.orders },
      { label: "TOTAL SALES",   value: money(total),                color: COLOR.sales },
      { label: "AVERAGE ORDER", value: money(average),              color: COLOR.average }
    ];
    const cardGap = 15;
    const cardWidth = (CONTENT_W - cardGap * 2) / 3;
    cards.forEach((card, index) => {
      const x = MARGIN + index * (cardWidth + cardGap);
      doc.roundedRect(x, 174, cardWidth, 60, 6).lineWidth(1).fillAndStroke(COLOR.cream, COLOR.cardBorder);
      doc.roundedRect(x, 174, 4, 60, 2).fill(card.color);
      doc.fillColor(COLOR.mutedText).font("Helvetica-Bold").fontSize(8).text(card.label, x + 16, 187, { width: cardWidth - 28 });
      doc.fillColor(COLOR.darkText).font("Helvetica-Bold").fontSize(16).text(card.value, x + 16, 202, { width: cardWidth - 28 });
    });

    // ➕ ADDED: cancelled summary line under the cards (only when there are cancellations)
    if (cancelledOrders.length) {
      doc.fillColor(COLOR.cancelledText).font("Helvetica-Bold").fontSize(8.5).text(
        `${cancelledOrders.length} cancelled order(s) worth ${money(cancelledTotal)} - shown in red below and NOT counted in the totals above.`,
        MARGIN, 241, { width: CONTENT_W, lineBreak: false }
      );
    }

    /*----------------------------- ORDER TABLE -----------------------------*/
    doc.fillColor(COLOR.darkText).font("Helvetica-Bold").fontSize(10).text("ORDER BREAKDOWN", MARGIN, 258);
    drawTableHeader(doc, 276);
    doc.y = 276 + 26 + 8;

    if (!orders.length) {
      doc.fillColor(COLOR.mutedText).font("Helvetica").fontSize(10)
        .text("No orders were placed during this period.", MARGIN + 7, doc.y);
    } else {
      orders.forEach((order, index) => {
        const cancelled = isCancelled(order);   // ➕ ADDED

        const details = [pdfSafeText(order.food)];
        if (order.includedChicken) details.push(`Includes ${order.includedChicken} chicken`);
        if (order.soup) details.push(`Soup: ${pdfSafeText(order.soup)}`);
        if (order.proteinSummary) details.push(pdfSafeText(order.proteinSummary).replace(/[\r\n]+/g, ", "));
        const detailText = details.join(" | ");
        const customer = pdfSafeText(order.customerPhone || order.customer_phone || "-");
        const rowHeight = Math.max(36, doc.heightOfString(detailText, { width: 158 }) + 18);

        if (doc.y + rowHeight > 745) {
          drawFooter(doc, doc.bufferedPageRange().count);
          doc.addPage();
          drawTableHeader(doc, MARGIN);
          doc.y = MARGIN + 26 + 8;
        }

        const y = doc.y;
        // ➕ CHANGED: cancelled rows get a light red background instead of the cream striping
        if (cancelled) doc.roundedRect(MARGIN, y - 2, CONTENT_W, rowHeight, 3).fill(COLOR.cancelledRow);
        else if (index % 2 === 0) doc.roundedRect(MARGIN, y - 2, CONTENT_W, rowHeight, 3).fill(COLOR.rowAlt);

        const mainText = cancelled ? COLOR.mutedText : COLOR.darkText;   // ➕ ADDED: greyed-out text for cancelled

        doc.fillColor(mainText).font("Helvetica-Bold").fontSize(8).text(pdfSafeText(order.id), 48, y + 8, { width: 70 });
        if (cancelled) drawCancelledTag(doc, 48, y + 21);   // ➕ ADDED
        doc.fillColor(COLOR.mutedText).font("Helvetica").fontSize(8).text(
          new Date(order.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
          118, y + 8, { width: 40 }
        );
        doc.fillColor(mainText).text(customer, 164, y + 8, { width: 82 });
        doc.text(detailText, 252, y + 6, { width: 158, lineGap: 2 });
        drawMethodPill(doc, order.fulfillment, 420, y + 6, 58);

        if (cancelled) {
          // ➕ ADDED: cancelled amount is greyed out and struck through
          doc.fillColor(COLOR.cancelledText).font("Helvetica").fontSize(9)
            .text(money(order.total), 476, y + 8, { width: 79, align: "right", strike: true });
        } else {
          doc.fillColor(COLOR.darkText).font("Helvetica-Bold").fontSize(9).text(money(order.total), 476, y + 8, { width: 79, align: "right" });
        }

        doc.y = y + rowHeight;
      });

      /*-------------------------- TOTAL SUMMARY ROW --------------------------*/
      if (doc.y + 34 > 745) {
        drawFooter(doc, doc.bufferedPageRange().count);
        doc.addPage();
        doc.y = MARGIN;
      }
      const totalY = doc.y + 8;
      doc.moveTo(MARGIN, totalY).lineTo(PAGE_WIDTH - MARGIN, totalY).lineWidth(1).strokeColor(COLOR.ruleColor).stroke();
      doc.fillColor(COLOR.darkText).font("Helvetica-Bold").fontSize(10)
        .text("TOTAL SALES", 252, totalY + 10, { width: 158 });
      doc.fontSize(11).text(money(total), 476, totalY + 9, { width: 79, align: "right" });
      // ➕ ADDED: reminder that cancelled orders are excluded
      if (cancelledOrders.length) {
        doc.fillColor(COLOR.mutedText).font("Helvetica").fontSize(7.5)
          .text("Cancelled orders not counted", 252, totalY + 25, { width: 158, lineBreak: false });
      }
      doc.y = totalY + 34;
    }

    drawFooter(doc, doc.bufferedPageRange().count);
    doc.end();
  });
}

module.exports = { createReportPdf, getOrders, getPeriodRange, saveOrder, updateOrderStatus };
