const PDFDocument = require("pdfkit");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

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

async function saveOrder(order) {
  if (!supabase) return;
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
  if (error) throw error;
}

async function getOrders(branch, period, fallbackOrders) {
  const range = getPeriodRange(period);
  const localOrders = Array.from(fallbackOrders.values())
    .filter(order => order.branch === branch && isInRange(order, range));

  if (!supabase) return localOrders;

  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("branch", branch)
    .gte("created_at", range.start.toISOString())
    .lt("created_at", range.end.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("SUPABASE REPORT ERROR:", error.message);
    return localOrders;
  }

  const storedOrders = data.map(order => ({
    ...order,
    customerPhone: order.customer_phone,
    basePrice: order.base_price,
    includedChicken: order.included_chicken,
    proteinSummary: order.protein_summary,
    fulfillment: order.fulfillment,
    createdAt: order.created_at
  }));

  const combined = [...storedOrders, ...localOrders];
  const seen = new Set();
  return combined.filter(order => {
    const key = `${order.id}|${order.createdAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
}

function money(value) {
  return `GHS ${Number(value || 0).toFixed(2)}`;
}

function pdfSafeText(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, "");
}

function drawTableHeader(doc, columns, y) {
  doc.save();
  doc.rect(40, y, 515, 24).fill("#17324D");
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
  columns.forEach(column => doc.text(column.label, column.x + 7, y + 8, { width: column.width - 14 }));
  doc.restore();
}

function createReportPdf(branch, period, orders) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const total = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const average = orders.length ? total / orders.length : 0;
    const columns = [
      { label: "ORDER ID", x: 40, width: 82 },
      { label: "TIME", x: 122, width: 52 },
      { label: "CUSTOMER", x: 174, width: 90 },
      { label: "ORDER DETAILS", x: 264, width: 160 },
      { label: "METHOD", x: 424, width: 65 },
      { label: "TOTAL", x: 489, width: 66 }
    ];

    doc.rect(0, 0, 595, 108).fill("#17324D");
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(22).text("JULJONES FOOD", 40, 28);
    doc.fontSize(11).font("Helvetica").fillColor("#B8DDE0").text("BRANCH PERFORMANCE REPORT", 40, 58);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#FFFFFF").text(branch, 420, 30, { width: 135, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor("#B8DDE0").text(period.toUpperCase(), 420, 50, { width: 135, align: "right" });
    doc.fillColor("#253B53").font("Helvetica-Bold").fontSize(16).text(`${period[0].toUpperCase()}${period.slice(1)} order report`, 40, 132);
    doc.fillColor("#6B7785").font("Helvetica").fontSize(9).text(`Generated ${new Date().toLocaleString("en-GB")}`, 40, 155);

    const cards = [
      { label: "ORDERS", value: String(orders.length), color: "#2A9D8F" },
      { label: "TOTAL SALES", value: money(total), color: "#E08E0B" },
      { label: "AVERAGE ORDER", value: money(average), color: "#457B9D" }
    ];
    cards.forEach((card, index) => {
      const x = 40 + index * 172;
      doc.roundedRect(x, 180, 160, 58, 5).fill("#F1F5F8");
      doc.rect(x, 180, 5, 58).fill(card.color);
      doc.fillColor("#6B7785").font("Helvetica-Bold").fontSize(8).text(card.label, x + 16, 193);
      doc.fillColor("#17324D").font("Helvetica-Bold").fontSize(15).text(card.value, x + 16, 208, { width: 135 });
    });

    doc.fillColor("#253B53").font("Helvetica-Bold").fontSize(10).text("ORDER BREAKDOWN", 40, 270);
    drawTableHeader(doc, columns, 288);

    if (!orders.length) {
      doc.fillColor("#6B7785").font("Helvetica").fontSize(10).text("No orders were placed during this period.", 47, 330);
    } else {
      orders.forEach((order, index) => {
        const details = [pdfSafeText(order.food)];
        if (order.soup) details.push(`Soup: ${pdfSafeText(order.soup)}`);
        if (order.proteinSummary) details.push(pdfSafeText(order.proteinSummary).replace(/[\r\n]+/g, ", "));
        const detailText = details.join(" | ");
        const customer = pdfSafeText(order.customerPhone || order.customer_phone || "-");
        const rowHeight = Math.max(34, doc.heightOfString(detailText, { width: 146 }) + 16);

        if (doc.y + rowHeight > 760) {
          doc.addPage();
          drawTableHeader(doc, columns, 48);
          doc.y = 72;
        }

        const y = doc.y;
        if (index % 2 === 0) doc.rect(40, y, 515, rowHeight).fill("#F1F5F8");
        doc.fillColor("#253B53").font("Helvetica-Bold").fontSize(8).text(pdfSafeText(order.id), 47, y + 10, { width: 68 });
        doc.font("Helvetica").text(new Date(order.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }), 129, y + 10, { width: 38 });
        doc.text(customer, 181, y + 10, { width: 76 });
        doc.text(detailText, 271, y + 8, { width: 146, lineGap: 2 });
        doc.text(order.fulfillment === "pickup" ? "Pick up" : "Delivery", 431, y + 10, { width: 51 });
        doc.font("Helvetica-Bold").text(money(order.total), 496, y + 10, { width: 52, align: "right" });
        doc.y = y + rowHeight;
      });
    }

    doc.fillColor("#6B7785").font("Helvetica").fontSize(8).text("Juljones Food - Confidential branch report", 40, 795, { width: 515, align: "center" });

    doc.end();
  });
}

module.exports = { createReportPdf, getOrders, getPeriodRange, saveOrder };