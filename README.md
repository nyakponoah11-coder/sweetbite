# 🍛 Stoney Shop WhatsApp Food Ordering Bot

A WhatsApp Cloud API food ordering bot for Stoney Shop.

Customers can:

- Select their nearest branch
- Select food
- Select food amount
- Select multiple proteins
- Choose pickup or delivery
- Provide delivery address
- Confirm their order
- Receive order status notifications

There is no online payment.

Delivery orders are paid on delivery.

## Branch Reports

A branch can send `report` from its configured WhatsApp number and choose `Daily`,
`Weekly`, or `Monthly`. The bot sends back a PDF containing the orders and total
sales for that branch and period.

Reports use Supabase when these environment variables are configured:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Run [supabase/schema.sql](supabase/schema.sql) once in the Supabase SQL Editor.
The service-role key must stay on the server and must not be exposed in a browser.

---

# 🏪 Branches

The bot currently supports:

1. Abeka
2. Fadama
3. Tabora
5. GCTU
6. Race

Each branch has a different WhatsApp number.

The bot uses one WhatsApp Cloud API account to send the messages.

The branch numbers are simply recipients.

---

# 🍽️ Food Menu

## Fried Rice

| Price | Chicken |
|---|---|
| ₵20 | 1 chicken |
| ₵25 | 1 chicken |
| ₵30 | 1 chicken |
| ₵40 | 1 chicken |
| ₵50 | 2 chicken |

---

## Jollof Rice

| Price | Chicken |
|---|---|
| ₵20 | 1 chicken |
| ₵25 | 1 chicken |
| ₵30 | 1 chicken |
| ₵40 | 1 chicken |
| ₵50 | 2 chicken |

---

## Fufu

Customers can choose any base amount:

₵10 - ₵100

---

## Banku

Customers can choose any base amount:

₵10 - ₵100

---

## Kokonte

Customers can choose any base amount:

₵10 - ₵100

---

# 🥩 Proteins

| Protein | Price |
|---|---:|
| Chicken | ₵15 |
| Cow Intestines | ₵10 |
| Fish | ₵20 |
| Egg | ₵4 |

Customers can add multiple proteins.

For example:

Fufu ₵30

Chicken = ₵15

Fish = ₵20

Egg = ₵4

Total:

₵30 + ₵15 + ₵20 + ₵4

= ₵69

---

# 🚚 Order Methods

Customers can select:

## Pick Up

The customer comes to the selected branch.

No delivery fee.

## Delivery

The customer provides their address.

Payment is made to the rider when the food arrives.

There is no Paystack integration.

---

# 🔄 Customer Flow

```text
Customer sends Hi
        ↓
Welcome to Stoney Shop
        ↓
Select Branch
        ↓
Select Food
        ↓
Select Portion / Amount
        ↓
Select Protein
        ↓
Add More Protein
        ↓
Pick Up / Delivery
        ↓
Delivery Address
        ↓
Order Summary
        ↓
Place Order
        ↓
Branch receives order
        ↓
Branch prepares food
        ↓
Customer receives status
