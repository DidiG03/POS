# Security Hardening Guide

This document outlines the security measures implemented in the POS system and how to configure them.

## ✅ Security Features Implemented

### 1. **Rate Limiting**
- **IPC Handlers**: Rate limiting for critical IPC handlers (login, ticket creation, user management)
  - Login attempts: 5 attempts per 5 minutes
  - Ticket creation: 100 attempts per minute
  - User management: 20 attempts per minute
- **HTTP API**: Rate limiting for login attempts (20-30 attempts per 10 minutes per IP)
- **Cloud Backend**: Rate limiting for all auth endpoints

**Configuration**: Default limits can be adjusted in `src/main/services/security.ts` and `src/main/api.ts`

### 2. **Input Validation & Sanitization**
- **Zod Schemas**: All user inputs validated with Zod schemas
- **XSS Prevention**: String sanitization removes HTML tags, script tags, and event handlers
- **SQL Injection Prevention**: Prisma ORM with parameterized queries (no raw SQL)
- **PIN Validation**: PINs must be 4-6 digits, weak PINs (1234, 0000, etc.) are rejected

**Location**: `src/main/services/security.ts`

### 3. **Secure Token Storage**
- **JWT Tokens**: Tokens stored in localStorage (standard for browser clients)
- **Session Expiry**: Tokens expire after 12 hours
- **Token Rotation**: Tokens are rotated on login

**Note**: For enhanced security in production, consider encrypted storage (see "Future Enhancements" below)

### 4. **Security Headers**
HTTP responses include security headers:
- **Content-Security-Policy**: Prevents XSS attacks
- **X-Content-Type-Options**: Prevents MIME type sniffing
- **X-XSS-Protection**: Legacy XSS protection
- **X-Frame-Options**: Prevents clickjacking (DENY)
- **Referrer-Policy**: Controls referrer information
- **HSTS**: HTTP Strict Transport Security (HTTPS only)

**Location**: `src/main/api.ts` → `setSecurityHeaders()`

### 5. **CORS (Cross-Origin Resource Sharing)**
- **Restrictive**: Only explicitly allowed origins can access the API
- **Configuration**: Set via `POS_CORS_ORIGINS` environment variable
- **Development**: `localhost:5173` and `127.0.0.1:5173` allowed automatically

**Configuration**: 
```bash
export POS_CORS_ORIGINS="https://your-domain.com,https://another-domain.com"
```

### 6. **Authentication & Authorization**
- **PIN Hashing**: bcrypt with 10 rounds (salt included)
- **Session Expiry**: 12 hours (configurable)
- **Role-Based Access**: ADMIN, CASHIER, WAITER roles with proper checks
- **Manager PIN Approval**: Required for sensitive actions (discounts, voids)

**Location**: `src/main/index.ts`, `server/src/routes/auth.ts`

### 7. **Security Audit Logging**
- **In-Memory Log**: Last 1000 security events stored in memory
- **Events Logged**:
  - Rate limit exceeded
  - Invalid PIN formats
  - User updates
  - Login attempts
  - Suspicious activity
- **Admin Access**: Security log visible in admin panel

**Location**: `src/main/services/security.ts` → `logSecurityEvent()`, `getSecurityLog()`

### 8. **Electron Security**
- **Context Isolation**: Enabled (prevents renderer from accessing Node APIs)
- **Sandbox**: Enabled (restricts renderer capabilities)
- **Node Integration**: Disabled (renderer cannot access Node APIs directly)
- **Preload Script**: Only exposes necessary APIs via `contextBridge`

**Location**: `src/main/index.ts` → `createWindow()`, `src/preload/index.ts`

---

## 🔒 Security Best Practices

### For Production Deployment

1. **Use HTTPS**:
   ```bash
   export HTTPS_ENABLED=true
   # Provide key.pem and cert.pem in project root
   ```

2. **Restrict CORS**:
   ```bash
   export POS_CORS_ORIGINS="https://your-production-domain.com"
   ```

3. **Use Strong PINs**:
   - Encourage users to use non-sequential PINs
   - Consider implementing PIN complexity requirements (future enhancement)

4. **Enable Rate Limiting**:
   - Already enabled by default
   - Adjust limits based on your needs in `src/main/services/security.ts`

5. **Monitor Security Logs**:
   - Regularly review security logs in admin panel
   - Set up alerts for suspicious activity (future enhancement)

6. **Code Signing**:
   - Sign Electron app for macOS and Windows
   - Required for auto-updates and user trust

7. **Regular Updates**:
   - Keep dependencies updated
   - Monitor security advisories for Electron, Node.js, and other dependencies

---

## 🛡️ Security Configuration

### Environment Variables

```bash
# CORS origins (comma-separated)
POS_CORS_ORIGINS=https://domain1.com,https://domain2.com

# Enable HTTPS
HTTPS_ENABLED=true

# Disable auto-updates (if needed)
AUTO_UPDATE_ENABLED=false

# Disable Sentry (if not using)
# (Just don't set SENTRY_DSN)
```

### Security Settings in Admin Panel

- **Manager PIN Approval**: Enable for discounts, voids, service charge removal
- **Pairing Code**: Require for LAN connections (prevents unauthorized devices)

---

## 📊 Security Audit Log

The security log tracks:
- Rate limit violations
- Invalid PIN attempts
- User management actions
- Suspicious activity patterns

**Access**: Admin Panel → Security Log (if implemented in UI)

**API**: `admin:getSecurityLog` IPC handler

---

## 🚨 Known Security Considerations

### Current Limitations

1. **Token Storage**: Tokens stored in localStorage (standard, but not encrypted)
   - **Mitigation**: Tokens expire after 12 hours
   - **Future**: Consider encrypted storage for sensitive environments

2. **Rate Limiting**: In-memory (resets on app restart)
   - **Mitigation**: Persistent rate limiting could be added (Redis/database)
   - **Current**: Sufficient for single-instance deployments

3. **PIN Complexity**: Basic validation (4-6 digits, rejects common PINs)
   - **Future**: Could add stronger requirements (no repeated digits, etc.)

4. **Security Log**: In-memory only (lost on restart)
   - **Future**: Could persist to database for audit trail

### Threat Model

**Protected Against**:
- ✅ SQL Injection (Prisma ORM)
- ✅ XSS (Input sanitization, React escaping)
- ✅ CSRF (CORS restrictions, token validation)
- ✅ Brute Force (Rate limiting)
- ✅ Clickjacking (X-Frame-Options)
- ✅ MIME Sniffing (X-Content-Type-Options)

**Not Protected Against** (by design or limitation):
- ⚠️ Physical access to device (unlock device = access to POS)
- ⚠️ Network interception (use HTTPS in production)
- ⚠️ Social engineering (training required)
- ⚠️ Insider threats (audit logs help, but not foolproof)

---

## 🔧 Security Hardening Checklist

### Before Production

- [ ] Enable HTTPS (`HTTPS_ENABLED=true`)
- [ ] Configure CORS origins (`POS_CORS_ORIGINS`)
- [ ] Review rate limiting thresholds
- [ ] Enable manager PIN approval for sensitive actions
- [ ] Set up security log monitoring
- [ ] Code sign the Electron app
- [ ] Enable auto-updates (for security patches)
- [ ] Review and test security headers
- [ ] Audit user roles and permissions
- [ ] Test rate limiting under load
- [ ] Review input validation on all endpoints
- [ ] Test XSS protection with malicious inputs
- [ ] Verify SQL injection protection (Prisma should handle this)
- [ ] Test CORS restrictions
- [ ] Review and update dependencies for security patches

---

## 🔍 Security Testing

### Manual Testing

1. **Rate Limiting**:
   - Try logging in 6 times rapidly (should be rate limited after 5)

2. **XSS Protection**:
   - Try entering `<script>alert('XSS')</script>` in user inputs
   - Should be sanitized/escaped

3. **PIN Validation**:
   - Try using weak PINs (1234, 0000)
   - Should be rejected

4. **CORS**:
   - Try accessing API from unauthorized origin
   - Should be blocked

### Automated Testing (Future)

- Unit tests for input sanitization
- Integration tests for rate limiting
- Security scanning (npm audit, Snyk, etc.)

---

## 📚 Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Electron Security Guide](https://www.electronjs.org/docs/latest/tutorial/security)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

---

## 🚀 Future Security Enhancements

1. **Encrypted Token Storage**: Use Electron's `safeStorage` API for sensitive data
2. **Persistent Security Log**: Store audit logs in database
3. **Two-Factor Authentication**: Add 2FA for admin users
4. **PIN Complexity Requirements**: Enforce stronger PIN rules
5. **Security Alerts**: Email/SMS alerts for suspicious activity
6. **IP Whitelisting**: Restrict access to known IP addresses
7. **Session Management**: View and revoke active sessions
8. **Security Scanning**: Automated vulnerability scanning in CI/CD

---

*Last updated: 2025-01-09*
