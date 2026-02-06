# Windows VMware “real customer” test (easy mode)

Goal: install and run Code Orbit POS in a Windows VM exactly like a customer (no Node.js, no Git, no build tools).

## Step 1: Build the Windows installer using GitHub Actions

1. Push your latest code to GitHub.
2. In GitHub, open **Actions**.
3. Select workflow **Build Windows Installer**.
4. Click **Run workflow**.
5. Wait for it to finish.
6. Open the workflow run → **Artifacts** → download `windows-installer`.
7. Unzip it. You should see a `*.exe` installer (NSIS).

## Step 2: Install inside the Windows VM

1. Copy the installer `.exe` into the VM (drag/drop or shared folder).
2. Double-click the installer.
3. Click **Next → Install → Finish**.
4. Open **Code Orbit POS** from the Start Menu.

## Step 3: Connect to Cloud backend (most realistic)

In the app:
- Admin → Settings → **Log In to Cloud**
- Backend URL: your Cloud Run URL (example: `https://pos-api-...run.app`)
- Enter **Business code** + **Business password**

Now you can test the full customer flow.

