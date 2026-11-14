# 🍛 Sweet Bite WhatsApp Food Ordering Bot (0 Meta Fees)

A **100% free** WhatsApp food ordering bot for **Sweet Bite (LAPAZ branch)** powered by **Baileys Multi-Device**.

> [!NOTE]
> **Zero Meta API Charges**: This bot connects directly to WhatsApp via Multi-Device QR code (like WhatsApp Web). You do **NOT** need a Meta Developer account, credit card, access tokens, phone number IDs, or per-conversation Meta fees!

---

## 🍽️ Customer Ordering Flow

```text
Customer sends "Hi"
        ↓
Welcome message & Menu displayed (1. Jollof Rice, 2. Fried Rice)
        ↓
Select Portion Size (₵30, ₵40, ₵50, ₵60)
        ↓
Choose Method (1. Pick Up, 2. Delivery)
        ↓
Delivery Address (if Delivery selected)
        ↓
Order Confirmation Summary
        ↓
Order Placed & Sent to LAPAZ Branch WhatsApp
        ↓
Kitchen Prepares & Customer Receives Real-time Updates!
```

Customers can reply with either numbers (`1`, `2`, `3`, `4`) or words (`jollof`, `fried`, `pickup`, `delivery`, `confirm`, `cancel`).

---

## 👨‍🍳 Kitchen / Staff Commands

Orders are automatically sent to the configured `LAPAZ_BRANCH_NUMBER`. Kitchen staff can manage order progress directly from WhatsApp by replying:

- `prepare SB-1234` — Marks order as **Preparing** and alerts the customer.
- `ready SB-1234` — Marks order as **Food Ready** for pickup or dispatch.
- `rider SB-1234` — Marks order as **Out for Delivery** (with Pay on Delivery reminder).
- `pickup SB-1234` — Marks order as **Picked Up**.

---

## 📊 Branch PDF Reports

The branch can text `report` to request sales summaries:
1. `1` or `daily` — Daily sales report
2. `2` or `weekly` — Weekly sales report
3. `3` or `monthly` — Monthly sales report

The bot automatically generates and sends back a clean PDF summary containing all orders and revenue.

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure Environment (`.env`)
Create a `.env` file (or copy `.env.example`):
```env
PORT=3000
STORE_NAME=Sweet Bite
LAPAZ_BRANCH_NUMBER=233241234567

# Optional Supabase database for persistent order history:
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

### 3. Start the Bot
```bash
npm start
```

### 4. Link WhatsApp
- When you start the bot, a **QR code** is printed in your terminal.
- Or open the web dashboard in your browser: `http://localhost:3000` and view the live QR code on screen.
- Open **WhatsApp** on your phone &rarr; **Linked Devices** &rarr; **Link a Device** &rarr; Scan the QR code.
- That's it! Your bot is live with **$0 / ₵0 Meta fees**. Session credentials are saved locally in `./baileys_auth_info` so it reconnects automatically on reboot.
