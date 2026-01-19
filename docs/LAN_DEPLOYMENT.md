# LAN deployment & security notes

This POS can run in two modes:

## 1) Single-device mode (recommended default)

- The Electron app runs locally on the same machine.
- The local HTTP API binds to **127.0.0.1** (loopback), so **other devices on the network cannot access it**.

## 2) LAN mode (tablets/phones connect over Wi‑Fi)

- The Electron app runs on one “host” computer.
- Tablets/phones open the UI in a browser and call the host’s local API over the LAN.

### How to enable LAN mode

Set one of the following before starting the app:

- `POS_ALLOW_LAN=true` (binds to `0.0.0.0`)
- or explicitly: `POS_BIND_HOST=0.0.0.0`

Ports:

- **3333**: HTTP API
- **3443**: HTTPS API (only if `key.pem` + `cert.pem` exist; otherwise HTTPS is skipped)

### Browser clients (tablets/phones)

- `localhost` from a phone means the **phone**, not the host computer.
- Use the host computer’s LAN IP, e.g. `http://192.168.1.50:3333/renderer/`

### Authentication

- Browser/LAN requests require a **Bearer token** returned by `POST /auth/login`.
- The token is stored in localStorage by the browser client and sent as `Authorization: Bearer <token>`.
- The SSE endpoint (`/events`) uses `?token=...` because `EventSource` can’t send headers.

### CORS

- Same-origin requests are allowed automatically.
- For development, `http://localhost:5173` is allowed.
- You can add explicit allowed origins with: `POS_CORS_ORIGINS="http://192.168.1.50:5173,http://example"`

### HTTPS on phones

If you use `https://...:3443` with a self-signed cert, iOS/Android may block it unless the certificate is installed/trusted.
For easiest LAN usage, prefer HTTP (`3333`) or set up a proper trusted certificate.


