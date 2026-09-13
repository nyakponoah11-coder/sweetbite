# 🍛 Sweet Bite WhatsApp Food Ordering Bot

A WhatsApp Cloud API food ordering bot for **Sweet Bite**.

Customers can:

- Say "Hi" and see the menu right away
- Select Jollof Rice or Fried Rice
- Select a price
- Choose pickup or delivery
- Provide a delivery address
- Confirm their order
- Receive order status notifications

There is no online payment. Delivery orders are paid on delivery.

---

# 🏪 Branch

There is only **one** branch: **LAPAZ**.

There is no branch-selection step — every order goes straight to the LAPAZ
branch number.

The bot uses one WhatsApp Cloud API account to send messages. The LAPAZ
branch number is simply the recipient that new orders are sent to, and the
number staff use to request reports.

---

# 🍽️ Food Menu

Only two items are on the menu:

- Jollof Rice
- Fried Rice

## Prices

| Price   |
|---------|
| ₵30     |
| ₵35     |
| ₵40     |
| ₵45     |
| ₵50     |

---

# 🚚 Order Methods

Customers can select:

## Pick Up

The customer comes to the LAPAZ branch. No delivery fee.

## Delivery

The customer provides their address. Payment is made to the rider when the
food arrives. There is no online payment integration.

---

# 🔄 Customer Flow

```text
Customer sends Hi
        ↓
Welcome to Sweet Bite + Menu shown
        ↓
Select Food (Jollof Rice / Fried Rice)
        ↓
Select Price (₵30 / ₵35 / ₵40 / ₵45 / ₵50)
        ↓
Pick Up / Delivery
        ↓
Delivery Address (if Delivery)
        ↓
Order Summary
        ↓
Place Order
        ↓
Order sent to LAPAZ branch number
        ↓
Branch prepares food
        ↓
Customer receives status updates
```

---

# 📊 Branch Reports

The LAPAZ branch can send `report` from its configured WhatsApp number and
choose `Daily`, `Weekly`, or `Monthly`. The bot generates and sends back a PDF
containing the orders and total sales for that period.

Reports use Supabase when these environment variables are configured:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Run [supabase/schema.sql](supabase/schema.sql) once in the Supabase SQL
Editor. The service-role key must stay on the server and must never be
exposed in a browser.

If Supabase isn't configured, reports fall back to in-memory orders from the
current server session.

---

# ⚙️ Environment Variables

```text
PORT=10000
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=

STORE_NAME=Sweet Bite

LAPAZ_BRANCH_NUMBER=
```

`LAPAZ_BRANCH_NUMBER` is the WhatsApp number of the LAPAZ branch — new orders
and staff status buttons are sent there, and it's the number staff text
`report` from.
