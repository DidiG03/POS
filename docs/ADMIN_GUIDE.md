# Admin Guide - POS System

**Last Updated**: 2025-01-09

This guide is for administrators managing the POS system.

---

## 🔐 Admin Access

### Logging In as Admin

1. **Launch the POS application**
2. **Select your admin account** from the staff list
3. **Enter your admin PIN**
4. **Click "Login"**
5. **Start your shift** (if prompted)

### Opening Admin Panel

1. **From the main POS window**, look for **"Admin"** or **"Settings"** in the navigation
2. **Click to open the Admin Panel**
3. You may need to **enter your PIN again** for security

> **Note**: Only users with the **ADMIN** role can access the admin panel.

---

## 👥 User Management

### Creating a New User

1. **Open Admin Panel**
2. Navigate to **"Users"** or **"Staff"** section
3. Click **"Create User"** or **"Add Staff"**
4. Fill in the form:
   - **Display Name**: User's name (e.g., "John Doe")
   - **Role**: Select from:
     - **WAITER**: Can take orders and process payments
     - **CASHIER**: Can process payments (if different from waiter)
     - **ADMIN**: Full access to admin panel
   - **PIN**: Enter 4-6 digit PIN (must not be weak like 1234, 0000)
   - **Active**: Check to enable the user immediately
5. Click **"Create"** or **"Save"**

### Editing a User

1. **Find the user** in the user list
2. **Click "Edit"** or click on the user's name
3. **Modify** any fields:
   - Display name
   - Role
   - PIN (leave blank to keep current PIN)
   - Active status
4. Click **"Save"**

### Disabling a User

1. **Edit the user**
2. **Uncheck "Active"**
3. **Save**

> **Note**: Disabled users cannot log in, but their historical data remains.

### Deleting a User

1. **Edit the user**
2. Click **"Delete"** or **"Remove"**
3. **Confirm deletion**

> **Warning**: Deleting a user may affect historical reports. Consider disabling instead.

---

## 🍽️ Menu Management

### Creating a Category

1. **Open Admin Panel**
2. Navigate to **"Menu"** section
3. Click **"Add Category"** or **"New Category"**
4. Enter **Category Name**
5. **(Optional)** Set **Sort Order** (lower numbers appear first)
6. Click **"Save"**

### Creating a Menu Item

1. **Select a category** or create a new one
2. Click **"Add Item"** or **"New Item"**
3. Fill in the form:
   - **Name**: Item name (e.g., "Burger")
   - **SKU**: Unique identifier (auto-generated if not provided)
   - **Price**: Item price (e.g., 10.50)
   - **VAT Rate**: Tax rate (e.g., 0.1 for 10%)
   - **Category**: Select category
   - **Station**: Select preparation station:
     - **KITCHEN**: Prepared in kitchen
     - **BAR**: Prepared at bar
     - **DESSERT**: Prepared at dessert station
   - **Enabled**: Check to make item visible to waiters
4. Click **"Save"**

### Editing a Menu Item

1. **Find the item** in the menu
2. **Click on the item** to edit
3. **Modify** any fields
4. Click **"Save"**

> **Note**: Disabled items appear with a strikethrough and "Disabled" badge in admin view.

### Disabling a Menu Item

1. **Edit the menu item**
2. **Uncheck "Enabled"**
3. **Save**

> **Note**: Disabled items are greyed out for waiters but remain visible in admin.

### Deleting a Menu Item

1. **Edit the menu item**
2. Click **"Delete"** or **"Remove"**
3. **Confirm deletion**

> **Note**: Deleted items are marked as inactive, not permanently deleted.

---

## ⚙️ Settings & Configuration

### Service Charge

1. **Open Admin Panel**
2. Navigate to **"Settings"** or **"Preferences"**
3. Find **"Service Charge"** section
4. **Enable** service charge
5. Choose **Mode**:
   - **PERCENT**: Percentage of total (e.g., 10%)
   - **AMOUNT**: Fixed amount (e.g., $5)
6. Enter **Value** (percentage or amount)
7. **Save**

> **Note**: Waiters can remove service charge, but may require manager approval.

### VAT (Tax)

1. **Navigate to "Settings" → "Preferences"**
2. Find **"VAT"** section
3. **Enable** or **Disable** VAT
4. **Save**

> **Note**: VAT rates are set per menu item. This toggle only enables/disables VAT calculation.

### Currency

1. **Navigate to "Settings" → "Preferences"**
2. Find **"Currency"** section
3. Enter **Currency Code** (e.g., "USD", "EUR", "GBP")
4. **Save**

> **Note**: Currency code should be an ISO 4217 code (3 letters).

### Approvals (Anti-Theft)

1. **Navigate to "Settings" → "Preferences"** or **"Approvals"**
2. Find **"Manager PIN Approval"** section
3. Enable approvals for:
   - **Discounts**: Require admin PIN for discounts
   - **Voids**: Require admin PIN for voiding items/tickets
   - **Service Charge Removal**: Require admin PIN to remove service charge
4. **Save**

> **Important**: Enabling approvals adds an extra layer of security but requires managers to approve sensitive actions.

---

## 🖥️ Kitchen Display System (KDS)

### Configuring KDS Stations

1. **Navigate to "Settings" → "Kitchen Display"**
2. **Enable** stations you want to use:
   - **Kitchen**
   - **Bar**
   - **Dessert**
3. **Save**

### Opening KDS Window

1. **Navigate to "Settings" → "Kitchen Display"**
2. Click **"Open Kitchen Display"**
3. A new window opens showing orders
4. Position this window on the kitchen tablet/monitor

### KDS Features

- **NEW tab**: Shows orders waiting to be prepared
- **Done tab**: Shows recently completed orders
- **Bump items**: Right-click (or long-press) an item and select "Bump" to mark as done
- **Auto-bump**: Orders older than 12 hours are automatically bumped

---

## 💾 Backup & Restore

### Creating a Backup

1. **Navigate to "Settings" → "Backups"**
2. Click **"Backup Now"**
3. Wait for backup to complete
4. Backup is saved with timestamp

> **Note**: Backups save all local data (orders, users, menu, settings).

### Restoring from Backup

1. **Navigate to "Settings" → "Backups"**
2. Click **"List Backups"**
3. **Select** the backup you want to restore
4. Click **"Restore"**
5. **Confirm** the restore
6. **Restart the application** (in development: restart `npm run dev`)

> **Warning**: Restoring a backup will replace all current data with the backup data. This cannot be undone.

---

## 📊 Reports & Analytics

### Admin Overview

The **Admin Overview** shows:
- **Active Users**: Number of currently logged-in users
- **Open Shifts**: Number of active shifts
- **Open Orders**: Number of tables with active orders
- **Low Stock Items**: Items below threshold (if inventory is enabled)
- **Queued Print Jobs**: Print jobs waiting to print
- **Revenue Today**: Net and VAT revenue for today
- **App Version**: Current version of the POS

### Sales Reports

1. **Navigate to "Reports"** in admin panel
2. View various reports:
   - **Top Selling Items**: Most sold items today
   - **Sales Trends**: Daily/weekly/monthly trends
   - **Ticket Counts**: Orders per user
   - **User Tickets**: Detailed ticket history per user

### Notifications

The admin panel shows notifications for:
- **Discounts applied**: When waiters apply discounts
- **Item requests**: When waiters request items from other tables
- **Security events**: Failed login attempts, suspicious activity
- **System alerts**: Low stock, errors, etc.

---

## 🌐 Cloud Setup (Hosted Mode)

### Enabling Cloud Mode

1. **Navigate to "Settings" → "Cloud"** or **"Hosted"**
2. Enter **Backend URL**: Your cloud backend URL (e.g., `https://api.yourdomain.com`)
3. Enter **Business Code**: Your unique business identifier
4. **Save**

> **Note**: Cloud mode requires a hosted backend. Contact your administrator or see deployment docs.

### Switching Between Local and Cloud

- **Local Mode**: All data stored locally on the device
- **Cloud Mode**: Data stored on remote server, synced across devices

You can switch modes in settings, but **data migration may be required**.

---

## 🔒 Security Settings

### Manager PIN Requirements

Configure which actions require manager approval:
- **Discounts**: Enable to require PIN for discounts
- **Voids**: Enable to require PIN for voiding
- **Service Charge Removal**: Enable to require PIN to remove service charge

### Session Management

- **Session Expiry**: Sessions automatically expire after 12 hours
- **Auto-logout**: Users are logged out after inactivity or session expiry

---

## 🖨️ Printer Configuration

### Setting Up Printer

1. **Navigate to "Settings" → "Printer"**
2. Enter **Printer IP**: Network IP address of thermal printer
3. Enter **Printer Port**: Usually 9100 (default for network printers)
4. **Test Print**: Click to send a test print
5. **Save**

> **Note**: Printer must be on the same network as the POS device.

---

## 🔄 Auto-Updates

### Update Settings

1. **Navigate to "Settings"**
2. View **Update Status**:
   - **Current Version**: Installed version
   - **Available Updates**: New versions available
   - **Update Status**: Checking, downloading, ready to install

### Installing Updates

1. **Check for updates** (automatic on startup)
2. If update is available, click **"Download Update"**
3. Once downloaded, click **"Install Update"**
4. **Restart** the application

> **Note**: Updates are configured via GitHub Releases or custom update server.

---

## 📱 Multi-Device Setup

### LAN Mode (Tablet Clients)

For tablets connecting to the main POS:

1. **Ensure main POS is running** on the host computer
2. **Note the IP address** of the host (shown in settings or console)
3. **On tablet**, open browser and navigate to: `http://[HOST_IP]:3333/renderer/`
4. **Log in** with your credentials

> **Note**: Host and tablets must be on the same network.

---

## 🆘 Troubleshooting

### Admin Can't Log In
- **Check PIN**: Ensure correct admin PIN
- **Check role**: Ensure account has ADMIN role
- **Check active status**: Ensure account is active

### Menu Changes Not Saving
- **Refresh**: Try refreshing the admin panel
- **Check network**: If cloud mode, check backend connection
- **Check permissions**: Ensure you're logged in as admin

### Reports Not Showing Data
- **Check date range**: Ensure correct date range is selected
- **Check data**: Verify there is actual data for the period
- **Refresh**: Try refreshing the reports page

### Backups Not Working
- **Check disk space**: Ensure sufficient disk space
- **Check permissions**: Ensure write permissions to backup directory
- **Check logs**: Look for error messages in console/logs

### KDS Not Showing Orders
- **Check station configuration**: Ensure stations are enabled
- **Check menu item stations**: Ensure items have correct station assigned
- **Refresh KDS**: Close and reopen KDS window

---

## 📞 Support & Maintenance

### Logs

Logs are stored in:
- **Development**: Console output
- **Production**: Check application data directory

### Error Tracking

Errors are automatically tracked via Sentry (if configured):
- **Development**: Errors logged to console
- **Production**: Errors sent to Sentry dashboard

---

## 🎯 Best Practices

1. **Regular Backups**: Create backups daily or before major changes
2. **User Management**: Disable rather than delete users when possible
3. **Menu Testing**: Test menu changes before making items active
4. **Security**: Enable manager approvals for sensitive actions
5. **Monitoring**: Regularly check admin overview and notifications
6. **Updates**: Keep the POS updated to latest version

---

*For installation instructions, see `INSTALLATION.md`*  
*For troubleshooting, see `TROUBLESHOOTING.md`*
