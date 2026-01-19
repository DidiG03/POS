# User Guide - POS System

**Last Updated**: 2025-01-09

This guide is for waiters and staff using the POS system.

---

## 📱 Getting Started

### Logging In

1. **Launch the POS application**
2. **Select your name** from the staff list
3. **Enter your PIN** (4-6 digits)
4. **Click "Login"**

> **Note**: If you don't see your name in the list, contact your administrator.

### Starting Your Shift

After logging in, you'll be asked to **start a shift**:
- Click **"Start Shift"** to begin your workday
- You'll be redirected to the **Tables** screen automatically

> **Note**: You must start a shift before taking orders.

---

## 🪑 Working with Tables

### Viewing Tables

The **Tables** screen shows all available tables in your restaurant layout:
- **🟢 Green tables**: Available (empty)
- **🔴 Red tables**: Occupied (has an active order)

You can switch between views:
- **Tables**: Default view showing table layout
- **Revenue**: Shows revenue per table
- **Time**: Shows how long each table has been occupied

### Opening a Table

1. **Click on an available (green) table**
2. The **Order** screen will open
3. The table is now marked as occupied

### Viewing Active Orders

- Click on any **occupied (red) table** to view/edit its current order
- The ticket number and timer show how long the table has been open

---

## 📝 Taking Orders

### Adding Items to an Order

1. **Select a table** (green or red)
2. **Browse menu items** by category
3. **Click on an item** to add it to the ticket
   - The item appears in the ticket on the right
   - Quantity is set to 1 by default
4. **Adjust quantity** by clicking the **+** or **-** buttons
5. **Remove an item** by clicking the **X** button

> **Note**: Disabled menu items (greyed out) cannot be added to orders.

### Order Details

The ticket panel shows:
- **Ticket number**: Unique order identifier
- **Table timer**: How long the table has been open (HH:MM:SS)
- **Items**: List of ordered items with:
  - Item name
  - Quantity
  - Unit price
  - Total price
  - Remove button (X)

### Totals Section

The ticket totals show:
- **Subtotal**: Sum of all items
- **VAT**: Tax amount (if enabled)
- **Service Charge**: Additional charge (if enabled and applied)
- **Total**: Final amount due

### Adding Notes

- **Table Note**: Add a note for the entire table/order
- **Item Notes**: Currently not supported in the UI

---

## 💳 Processing Payments

### Opening Payment Modal

1. **Ensure items are in the ticket**
2. **Click "Pay"** button at the bottom
3. The payment modal will open

### Payment Options

#### Cash Payment
1. Select **"Cash"** payment method
2. Enter **amount received** from customer
3. **Change** is calculated automatically
4. Click **"Complete Payment"**

#### Card Payment
1. Select **"Card"** payment method
2. Process payment through payment terminal (if configured)
3. Click **"Complete Payment"** after successful transaction

> **Note**: Card payments require payment terminal integration. Contact your administrator if card payments are not available.

### Applying Discounts

1. In the payment modal, scroll to **"Discount"** section
2. Choose discount type:
   - **Percentage**: Enter percentage (e.g., 10 for 10% off)
   - **Fixed Amount**: Enter fixed amount (e.g., 5 for $5 off)
3. **(Optional)** Enter a reason for the discount
4. The discount is automatically applied to the total

> **Important**: If manager approval is required, you'll need to enter an admin PIN to apply the discount.

### Service Charge

- **Service charge** is automatically added if configured by the administrator
- You can **remove** the service charge using the toggle in the payment modal
- **Manager approval** may be required to remove service charge

### Completing Payment

1. **Review the totals** (subtotal, VAT, discount, service charge, total)
2. **Ensure payment method is correct**
3. **Click "Complete Payment"**
4. The receipt will print automatically (if printer is configured)
5. The table will be marked as available (green)

---

## 🗑️ Voiding Items and Tickets

### Voiding an Item

1. **Open the order** for the table
2. **Click the "X" button** next to the item you want to void
3. Confirm the void
4. The item is removed from the ticket (but remains in records for audit)

> **Important**: If manager approval is required, you'll need to enter an admin PIN to void items.

### Voiding an Entire Ticket

1. **Open the order** for the table
2. **Click "Void Ticket"** button (usually at the bottom)
3. Confirm the void
4. The entire ticket is voided and the table is marked as available

> **Important**: If manager approval is required, you'll need to enter an admin PIN to void tickets.

---

## 📋 Requesting Items from Other Waiters

If you need to add items to another waiter's table:

1. **Add items to your ticket** as normal
2. **Click "Request to add items"** button
3. **Select the waiter** who owns the table
4. **Select the table** (area and label)
5. **Click "Send Request"**
6. The other waiter will receive a notification
7. When approved, items are added to their table

> **Note**: Only newly added (staged) items are sent in the request.

---

## 📊 Viewing Reports

### Accessing Reports

1. **Click "Reports"** in the navigation bar
2. View your personal statistics and ticket history

### Available Reports

#### Active Tickets
- Shows tickets for tables you currently have open
- Displays items, prices, and totals
- Updates automatically

#### Paid Tickets
- Shows your completed/paid tickets
- Search by date or table
- Displays receipt details with payment method

---

## 🔔 Notifications

You'll receive notifications for:
- **Item requests**: When another waiter requests to add items to your table
- **Request updates**: When your item requests are approved/rejected
- **System messages**: Important updates from administrators

**View notifications**: Click the notification bell icon (if available) or check the Reports page.

---

## 🌐 Network Status

The navigation bar shows your connection status:
- **🟢 Online**: Connected and synced
- **🟡 Syncing (N)**: N items queued for sync
- **🔴 Offline**: No connection (orders are queued locally)

> **Note**: The POS works offline. Orders are automatically synced when connection is restored.

---

## ⌨️ Keyboard Shortcuts

Currently, the POS is primarily mouse/touch-based. Keyboard shortcuts may be added in future updates.

---

## 🆘 Troubleshooting

### Can't Log In
- **Check your PIN**: Ensure you're entering the correct 4-6 digit PIN
- **Contact administrator**: Your account may be disabled

### Table Won't Open
- **Check if table is already occupied**: Try clicking on it again
- **Refresh the page**: Press `F5` or `Cmd+R` (Mac) / `Ctrl+R` (Windows)

### Payment Won't Complete
- **Check totals**: Ensure all calculations are correct
- **Check payment method**: Ensure correct method is selected
- **Try voiding and re-creating the ticket**: Click "Void Ticket" and start over

### Printer Not Working
- **Check printer connection**: Ensure printer is powered on and connected
- **Check network**: If using network printer, ensure it's reachable
- **Contact administrator**: Printer settings may need configuration

### Items Not Showing
- **Check if item is disabled**: Disabled items appear greyed out
- **Refresh menu**: Items may have been updated by administrator

---

## 💡 Tips & Best Practices

1. **Always verify totals** before completing payment
2. **Use notes** to communicate special requests to kitchen
3. **Void items immediately** if customer changes their mind
4. **Check table status** before opening a new order
5. **Review payment method** before completing (cash vs. card)
6. **Monitor network status** to ensure orders are syncing

---

## 📞 Support

If you encounter issues not covered in this guide:

1. **Contact your restaurant administrator**
2. **Check the Troubleshooting Guide** (if available)
3. **Note the error message** (if any) for support

---

*For administrator functions, see `ADMIN_GUIDE.md`*
