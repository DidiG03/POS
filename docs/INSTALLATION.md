# Installation Guide - POS System

**Last Updated**: 2025-01-09

This guide covers installing the POS system on different operating systems.

---

## 📋 System Requirements

### Minimum Requirements

- **Operating System**: Windows 10+, macOS 10.14+, or Linux (Ubuntu 20.04+)
- **RAM**: 4 GB minimum (8 GB recommended)
- **Storage**: 500 MB free space
- **Network**: Ethernet or Wi-Fi connection (for multi-device setup)
- **Display**: 1280x800 resolution minimum

### Recommended Requirements

- **RAM**: 8 GB or more
- **Storage**: 2 GB free space
- **Network**: Gigabit Ethernet (for faster sync)
- **Display**: 1920x1080 or higher

---

## 🪟 Windows Installation

### Method 1: Installer (Recommended)

1. **Download** the Windows installer (`.exe` or `.msi` file)
2. **Run the installer** as Administrator
3. **Follow the installation wizard**:
   - Accept the license agreement
   - Choose installation directory (default: `C:\Program Files\POS`)
   - Select components to install
   - Create desktop shortcut (recommended)
4. **Click "Install"**
5. **Wait for installation** to complete
6. **Click "Finish"**

### Method 2: Portable Version

1. **Download** the portable ZIP file
2. **Extract** to desired location (e.g., `C:\POS`)
3. **Run** `POS.exe` from the extracted folder
4. **Create shortcut** to desktop (optional)

### First Launch (Windows)

1. **Double-click** the POS shortcut or executable
2. **Windows Defender** may ask for permission - click **"Allow"**
3. The application will launch
4. Follow the **first-time setup** wizard (if available)

### Firewall Configuration

If you're using LAN mode (multi-device setup):

1. **Open Windows Firewall**
2. **Allow** the POS application through firewall
3. **Allow** ports 3333 (HTTP) and 3443 (HTTPS)

---

## 🍎 macOS Installation

### Method 1: DMG Installer (Recommended)

1. **Download** the macOS DMG file
2. **Open the DMG** file
3. **Drag** the POS application to **Applications** folder
4. **Eject** the DMG disk
5. **Open Applications** folder
6. **Right-click** POS app → **"Open"** (first time only)
7. **Click "Open"** in the security dialog

> **Note**: macOS may show a security warning. This is normal for unsigned apps. See "Security Settings" below.

### Method 2: Homebrew (Optional)

```bash
brew install --cask pos
```

### Security Settings (macOS)

If you see "POS cannot be opened because it is from an unidentified developer":

1. **Open System Preferences** → **Security & Privacy**
2. Click **"Open Anyway"** next to the security message
3. **Confirm** by clicking "Open"

For Gatekeeper bypass (if needed):
```bash
sudo xattr -rd com.apple.quarantine /Applications/POS.app
```

### Firewall Configuration (macOS)

1. **Open System Preferences** → **Security & Privacy** → **Firewall**
2. Click **"Firewall Options"**
3. **Add** POS application and set to "Allow incoming connections"
4. **Allow** ports 3333 (HTTP) and 3443 (HTTPS)

---

## 🐧 Linux Installation

### Method 1: AppImage (Recommended)

1. **Download** the AppImage file
2. **Make executable**:
   ```bash
   chmod +x POS.AppImage
   ```
3. **Run**:
   ```bash
   ./POS.AppImage
   ```

### Method 2: DEB Package (Debian/Ubuntu)

1. **Download** the `.deb` package
2. **Install**:
   ```bash
   sudo dpkg -i pos.deb
   ```
3. **Fix dependencies** (if needed):
   ```bash
   sudo apt-get install -f
   ```

### Method 3: RPM Package (Red Hat/Fedora)

1. **Download** the `.rpm` package
2. **Install**:
   ```bash
   sudo rpm -i pos.rpm
   ```

### Firewall Configuration (Linux)

**UFW (Ubuntu)**:
```bash
sudo ufw allow 3333/tcp
sudo ufw allow 3443/tcp
```

**FirewallD (Red Hat/Fedora)**:
```bash
sudo firewall-cmd --add-port=3333/tcp --permanent
sudo firewall-cmd --add-port=3443/tcp --permanent
sudo firewall-cmd --reload
```

---

## 🔧 First-Time Setup

### Initial Configuration

1. **Launch the POS** application
2. **First-time setup wizard** may appear (if configured)
3. **Configure**:
   - Business name
   - Admin account (if not already created)
   - Printer settings
   - Network settings

### Creating First Admin Account

If no users exist:

1. **On first launch**, you may be prompted to create an admin account
2. **Enter**:
   - Admin name
   - Admin PIN (4-6 digits, not weak like 1234)
3. **Click "Create"**

---

## 🌐 Network Setup (Multi-Device)

### Host Computer Setup

1. **Install POS** on the main computer
2. **Launch POS** application
3. **Note the IP address**:
   - Check Settings → Network
   - Or check console output for: `Server running on http://[IP]:3333`
4. **Ensure firewall** allows connections on port 3333

### Tablet/Client Setup

1. **On tablet**, open web browser (Chrome, Safari, etc.)
2. **Navigate to**: `http://[HOST_IP]:3333/renderer/`
   - Replace `[HOST_IP]` with the host computer's IP address
   - Example: `http://192.168.1.100:3333/renderer/`
3. **Bookmark** the page for easy access
4. **Log in** with your credentials

> **Note**: Host and clients must be on the same network (same Wi-Fi or LAN).

### Finding IP Address

**Windows**:
```cmd
ipconfig
```
Look for "IPv4 Address" under your network adapter.

**macOS/Linux**:
```bash
ifconfig
# or
ip addr
```
Look for `inet` address (usually 192.168.x.x or 10.0.x.x).

---

## 🖨️ Printer Setup

### Network Printer

1. **Ensure printer is on the same network**
2. **Find printer IP address**:
   - Check printer settings/display
   - Print network configuration page
   - Check router's connected devices
3. **In POS Settings** → **Printer**:
   - Enter printer IP address
   - Enter port (usually 9100 for network printers)
4. **Test Print**: Click "Test Print" to verify connection

### USB Printer

1. **Connect printer** via USB
2. **Install printer drivers** (if needed)
3. **Configure as network printer** or use local printing (if supported)

---

## 🔄 Updates

### Automatic Updates

The POS checks for updates automatically on startup:
- **Updates are downloaded** in the background
- **Notification** appears when update is ready
- **Click "Install"** to apply update
- **Restart** application

### Manual Update Check

1. **Open Settings**
2. **Check "Update Status"** section
3. **Click "Check for Updates"**

---

## ❌ Uninstallation

### Windows

1. **Open Control Panel** → **Programs** → **Uninstall a program**
2. **Find** "POS" in the list
3. **Click "Uninstall"**
4. **Confirm** uninstallation

Or use the uninstaller in the Start Menu.

### macOS

1. **Open Applications** folder
2. **Drag** POS app to **Trash**
3. **Empty Trash**

To remove all data:
```bash
rm -rf ~/Library/Application\ Support/POS
```

### Linux

**AppImage**: Delete the AppImage file

**DEB**:
```bash
sudo apt-get remove pos
```

**RPM**:
```bash
sudo rpm -e pos
```

---

## 🆘 Troubleshooting Installation

### Installation Fails

- **Check system requirements**: Ensure minimum requirements are met
- **Run as Administrator** (Windows) or with `sudo` (Linux)
- **Check disk space**: Ensure sufficient free space
- **Disable antivirus**: Temporarily disable to rule out interference

### App Won't Launch

**Windows**:
- Check Windows Event Viewer for errors
- Try running as Administrator
- Check antivirus isn't blocking the app

**macOS**:
- Check Console.app for error messages
- Try bypassing Gatekeeper (see Security Settings above)
- Check if app is from unidentified developer

**Linux**:
- Check if dependencies are installed
- Try running from terminal to see error messages:
  ```bash
  ./POS.AppImage
  ```

### Port Already in Use

If you see "Port 3333 already in use":
- **Close other instances** of the POS
- **Kill process** using the port:
  ```bash
  # Linux/macOS
  lsof -ti:3333 | xargs kill -9
  
  # Windows
  netstat -ano | findstr :3333
  taskkill /PID <PID> /F
  ```

---

## 📞 Support

If installation issues persist:

1. **Check logs**: Look for error messages in console/logs
2. **Contact support**: Provide:
   - Operating system and version
   - Installation method used
   - Error messages (if any)
   - Steps to reproduce

---

*For user guide, see `USER_GUIDE.md`*  
*For admin guide, see `ADMIN_GUIDE.md`*  
*For troubleshooting, see `TROUBLESHOOTING.md`*
