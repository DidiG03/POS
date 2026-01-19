# Troubleshooting Guide - POS System

**Last Updated**: 2025-01-09

Common issues and their solutions.

---

## 🔐 Authentication Issues

### Can't Log In

**Symptoms**: Login fails even with correct PIN

**Solutions**:
1. **Check PIN format**: Must be 4-6 digits
2. **Verify account is active**: Contact administrator
3. **Check for typos**: Re-enter PIN carefully
4. **Try another user**: Test if issue is user-specific
5. **Restart application**: Close and reopen the POS

### "Too many login attempts"

**Symptoms**: Rate limit error after multiple failed logins

**Solutions**:
1. **Wait 5-10 minutes**: Rate limit resets automatically
2. **Check if someone else is trying**: May be brute force attempt
3. **Contact administrator**: If issue persists

### Session Expired

**Symptoms**: Automatically logged out after inactivity

**Solutions**:
1. **This is normal**: Sessions expire after 12 hours
2. **Log in again**: Simply re-enter your credentials
3. **Start new shift**: If prompted

---

## 🪑 Table Issues

### Table Won't Open

**Symptoms**: Clicking table does nothing

**Solutions**:
1. **Refresh page**: Press `F5` or `Cmd+R` (Mac) / `Ctrl+R` (Windows)
2. **Check if table is already occupied**: May need to void existing ticket first
3. **Check network connection**: Ensure online or syncing
4. **Clear browser cache**: If using web client
5. **Restart application**: Close and reopen

### Table Stuck as Occupied

**Symptoms**: Table shows red but no active order

**Solutions**:
1. **Click the table**: May have hidden order
2. **Void the ticket**: If order exists, void it to free the table
3. **Refresh**: Press `F5` or restart app
4. **Contact administrator**: May need database reset

### Timer Not Updating

**Symptoms**: Table timer shows incorrect time

**Solutions**:
1. **Refresh page**: Timer updates on refresh
2. **Check system clock**: Ensure device time is correct
3. **Restart application**: Usually fixes timing issues

---

## 💳 Payment Issues

### Payment Won't Complete

**Symptoms**: Payment button does nothing or error appears

**Solutions**:
1. **Check totals**: Ensure all calculations are correct
2. **Check payment method**: Ensure correct method is selected
3. **Check manager approval**: May need admin PIN
4. **Check network**: Ensure online or syncing
5. **Try voiding and recreating**: Void ticket and start over

### Change Calculation Wrong

**Symptoms**: Change amount is incorrect

**Solutions**:
1. **Re-enter amount received**: Ensure correct amount entered
2. **Check currency**: Ensure currency settings are correct
3. **Calculate manually**: Verify: Amount Received - Total = Change

### Card Payment Not Working

**Symptoms**: Card payment option not available or fails

**Solutions**:
1. **Check if terminal is configured**: Contact administrator
2. **Check terminal connection**: Ensure terminal is powered on and connected
3. **Check network**: Terminal needs network connection
4. **Use cash instead**: Fall back to cash payment

---

## 🖨️ Printer Issues

### Printer Not Printing

**Symptoms**: No receipt prints after payment

**Solutions**:
1. **Check printer power**: Ensure printer is on
2. **Check connection**: 
   - Network printer: Check network connection
   - USB printer: Check USB cable
3. **Check printer IP**: Verify IP address in settings
4. **Test print**: Use "Test Print" button in settings
5. **Check printer paper**: Ensure paper is loaded
6. **Check printer status**: Look for error lights/messages

### Partial Print or Garbled Text

**Symptoms**: Receipt prints but is unreadable

**Solutions**:
1. **Check printer settings**: Ensure correct printer model selected
2. **Check paper width**: Ensure correct paper size
3. **Clean printer head**: May need cleaning
4. **Replace paper**: Paper may be damaged
5. **Restart printer**: Turn off and on

### Printer Offline

**Symptoms**: POS shows printer as offline

**Solutions**:
1. **Check network connection**: Printer must be on same network
2. **Ping printer IP**: Test connectivity:
   ```bash
   ping [PRINTER_IP]
   ```
3. **Check firewall**: Ensure port 9100 is open
4. **Restart printer**: Turn off and on
5. **Restart POS**: May reconnect on restart

---

## 🌐 Network & Sync Issues

### Offline Mode

**Symptoms**: Shows "Offline" or "Syncing (N)" status

**Solutions**:
1. **Check network connection**: Ensure Wi-Fi/Ethernet connected
2. **Check router**: Ensure router is working
3. **Restart network**: Turn Wi-Fi off and on
4. **Continue working**: POS works offline, will sync when online
5. **Check sync status**: Number shows queued items

### Orders Not Syncing

**Symptoms**: Orders remain in queue

**Solutions**:
1. **Check network**: Ensure connection is stable
2. **Wait**: May take time to sync large batches
3. **Restart application**: Force reconnection
4. **Check cloud backend**: If cloud mode, verify backend is accessible
5. **Contact administrator**: If sync fails consistently

### Can't Connect to Host (LAN Mode)

**Symptoms**: Tablet can't access `http://[IP]:3333`

**Solutions**:
1. **Check IP address**: Ensure correct host IP
2. **Check same network**: Host and tablet must be on same Wi-Fi/LAN
3. **Check firewall**: Ensure ports 3333/3443 are open on host
4. **Check host is running**: Ensure POS is running on host computer
5. **Try ping**: Test connectivity:
   ```bash
   ping [HOST_IP]
   ```

---

## 📊 Reports & Data Issues

### Reports Not Showing Data

**Symptoms**: Reports page is empty or shows zeros

**Solutions**:
1. **Check date range**: Ensure correct date range selected
2. **Check if data exists**: Verify orders were completed in that period
3. **Refresh**: Press `F5` or reload page
4. **Check user filter**: Ensure correct user selected
5. **Wait**: Reports may take time to load

### Wrong Totals in Reports

**Symptoms**: Revenue or totals are incorrect

**Solutions**:
1. **Check date range**: Ensure correct period
2. **Check filters**: Ensure no filters applied incorrectly
3. **Verify individual tickets**: Check if specific tickets are correct
4. **Recalculate**: May need to regenerate reports
5. **Contact administrator**: May need database check

### Missing Tickets

**Symptoms**: Expected tickets not appearing in reports

**Solutions**:
1. **Check user filter**: Ensure correct user selected
2. **Check date range**: Tickets may be outside range
3. **Check if voided**: Voided tickets may be filtered out
4. **Refresh**: Reload reports
5. **Contact administrator**: May need to check database

---

## 🍽️ Menu Issues

### Menu Items Not Showing

**Symptoms**: Items don't appear in menu

**Solutions**:
1. **Check if disabled**: Disabled items appear greyed out
2. **Check category**: Ensure correct category selected
3. **Refresh menu**: Menu may need refresh
4. **Check admin settings**: Items may be disabled by admin
5. **Restart application**: Usually refreshes menu

### Can't Add Item to Order

**Symptoms**: Clicking item does nothing

**Solutions**:
1. **Check if disabled**: Disabled items can't be added
2. **Check if table is open**: Need open table to add items
3. **Refresh page**: May fix UI issue
4. **Try different item**: Test if issue is item-specific
5. **Restart application**: Usually fixes UI issues

### Wrong Prices

**Symptoms**: Item prices are incorrect

**Solutions**:
1. **Check admin menu**: Verify prices in admin panel
2. **Refresh menu**: Prices may need refresh
3. **Contact administrator**: Prices may need updating

---

## 🔔 Notification Issues

### Not Receiving Notifications

**Symptoms**: Expected notifications don't appear

**Solutions**:
1. **Check notification settings**: May be disabled
2. **Check browser permissions**: Web clients need notification permission
3. **Refresh**: Notifications may need refresh
4. **Check admin panel**: View notifications in admin

### Too Many Notifications

**Symptoms**: Overwhelmed by notifications

**Solutions**:
1. **Mark as read**: Click to dismiss notifications
2. **Filter**: Use filters in admin panel
3. **Adjust settings**: May be able to reduce notification frequency

---

## ⚙️ Settings Issues

### Settings Not Saving

**Symptoms**: Changes don't persist after save

**Solutions**:
1. **Check permissions**: Ensure admin access
2. **Refresh**: Settings may need refresh to show
3. **Check network**: Cloud settings need network connection
4. **Restart application**: May apply settings on restart
5. **Contact administrator**: May need database check

### Can't Access Admin Panel

**Symptoms**: Admin panel won't open or shows error

**Solutions**:
1. **Check role**: Ensure account has ADMIN role
2. **Re-login**: Log out and log back in as admin
3. **Check permissions**: May need admin PIN
4. **Clear cache**: Clear browser cache if web client
5. **Restart application**: Usually fixes access issues

---

## 🐛 Application Crashes

### App Crashes on Startup

**Symptoms**: App closes immediately after opening

**Solutions**:
1. **Check logs**: Look for error messages in console/logs
2. **Check database**: Database may be corrupted (try backup restore)
3. **Reinstall**: Uninstall and reinstall application
4. **Check system requirements**: Ensure minimum requirements met
5. **Contact support**: Provide error logs

### App Freezes

**Symptoms**: App becomes unresponsive

**Solutions**:
1. **Wait**: May be processing large operation
2. **Force quit**: Close application and reopen
3. **Check resources**: Ensure sufficient RAM/CPU
4. **Clear cache**: Clear application cache
5. **Restart device**: May resolve resource issues

### Memory Issues

**Symptoms**: Slow performance or crashes

**Solutions**:
1. **Close other applications**: Free up memory
2. **Restart application**: Clears memory leaks
3. **Check RAM**: Ensure sufficient RAM (8GB+ recommended)
4. **Clear old data**: Archive old tickets/reports
5. **Contact support**: May need optimization

---

## 💾 Backup & Restore Issues

### Backup Fails

**Symptoms**: Can't create backup

**Solutions**:
1. **Check disk space**: Ensure sufficient free space
2. **Check permissions**: Ensure write permissions
3. **Check path**: Ensure backup directory exists
4. **Try different location**: May be path issue
5. **Contact administrator**: May need file system check

### Restore Fails

**Symptoms**: Can't restore from backup

**Solutions**:
1. **Check backup file**: Ensure backup is valid
2. **Check disk space**: Ensure sufficient space
3. **Close application**: May need to close before restore
4. **Try manual restore**: May need administrator help
5. **Contact support**: If restore consistently fails

---

## 📞 Getting Help

### Before Contacting Support

1. **Check this guide**: Many issues are covered here
2. **Check logs**: Look for error messages
3. **Note error messages**: Write down exact error text
4. **Note steps**: What were you doing when issue occurred?
5. **Check version**: Note your POS version (in settings)

### Contact Information

**Support Channels**:
- **Email**: [Support Email]
- **Phone**: [Support Phone]
- **In-App**: Check admin panel for support options

**Information to Provide**:
- Operating system and version
- POS version
- Error messages (if any)
- Steps to reproduce
- Screenshots (if applicable)

---

## 🔍 Advanced Debugging

### Viewing Logs

**Windows**:
- Check Event Viewer: `eventvwr.msc`
- Check application data folder: `%APPDATA%\POS\logs\`

**macOS**:
- Check Console.app: `/Applications/Utilities/Console.app`
- Check logs: `~/Library/Logs/POS/`

**Linux**:
- Check logs: `~/.config/POS/logs/`
- Check system logs: `/var/log/`

### Database Issues

If you suspect database corruption:
1. **Create backup** first (if possible)
2. **Try restore** from known good backup
3. **Contact support** with backup file

---

## ✅ Quick Fixes Checklist

If experiencing issues, try in this order:

1. ✅ **Refresh/Restart**: Refresh page or restart application
2. ✅ **Check Network**: Ensure connected to network
3. ✅ **Check Permissions**: Ensure correct user role/permissions
4. ✅ **Clear Cache**: Clear browser/application cache
5. ✅ **Update**: Ensure latest version installed
6. ✅ **Check Logs**: Look for error messages
7. ✅ **Contact Support**: If issue persists

---

*For installation help, see `INSTALLATION.md`*  
*For user guide, see `USER_GUIDE.md`*  
*For admin guide, see `ADMIN_GUIDE.md`*
