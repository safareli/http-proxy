# HTTPS Proxy with Telegram Approval Flow

## Overview
Build an HTTPS MITM proxy that intercepts requests, checks for secret tokens in headers, and requires Telegram approval for sensitive requests.

## Flow Logic
1. Request arrives at proxy
2. Log `METHOD URL` to console
3. Scan ALL header values for the host's fake secret token
4. **If secret NOT found** → Pass through to upstream as-is (no approval needed)
5. **If secret found**:
   - Check grants/rejections in config for `"METHOD /path"`
   - If permanently granted → substitute fake→real secret, forward
   - If permanently rejected → return 403
   - Otherwise → send Telegram message with inline keyboard:
     - Allow once / Allow forever / Reject once / Reject forever
   - Hold request open until user responds (5min timeout → 403 + treat as once-rejection)
   - If approved: substitute fake→real secret, forward to upstream
   - If rejected: return 403

## Architecture

### Files Structure
```
index.ts          # Telegram bot (existing)
proxy.ts          # HTTPS proxy server
config.ts         # Config management (load/save JSON)
certs/            # Generated certificates
  ca.key
  ca.crt
  server.key
  server.crt
proxy-config.json # Host configs, grants, rejections
```

### proxy-config.json Schema
```json
{
  "github.com": {
    "secret": "FAKE_GH_TOKEN_12345",
    "secretEnvVarName": "REAL_GITHUB_TOKEN",
    "grants": ["GET /api/user", "POST /api/repos"],
    "rejections": ["DELETE /api/repos"]
  }
}
```

**Secret substitution flow:**
1. VM sends request with fake/dumb `secret` (e.g., `FAKE_GH_TOKEN_12345`)
2. Proxy detects this secret in headers → requires approval
3. If approved, replace the fake secret with real one from `process.env[secretEnvVarName]`
4. Forward request with real secret to upstream

**Storage rules:**
- Only **permanent** grants/rejections are stored in config
- "Once" approvals/rejections are consumed immediately (in-memory only)

### Key Components

1. **Certificate Generation** (setup script)
   - Generate CA certificate (user installs in system/browser)
   - Generate server certificate signed by CA
   - Use `openssl` commands via script

2. **HTTP/HTTPS Proxy Server** (`proxy.ts`)
   - Two Bun servers: port 80 (HTTP) and port 443 (HTTPS with TLS)
   - Terminate TLS, inspect request headers, forward to real upstream
   - Async request holding using Promises
   - Return 403 on rejection/timeout

3. **Config Manager** (`config.ts`)
   - Load/save `proxy-config.json`
   - Methods: `getHostConfig()`, `hasGrant()`, `hasRejection()`, `addGrant()`, `addRejection()`
   - `getRealSecret(host)` → reads from `process.env[config.secretEnvVarName]`
   - `substituteSecret(headers, fakeSecret, realSecret)` → replaces in header values
   - Request key format: `"METHOD /path"` (without query string for matching)

4. **Telegram Integration** (modify `index.ts`)
   - Export function `requestApproval(host, method, url): Promise<'allow-once' | 'allow-forever' | 'reject-once' | 'reject-forever'>`
   - Send message with inline keyboard
   - Wait for callback, resolve promise
   - Handle pending requests map with unique IDs

5. **Request Holding Mechanism**
   - Map of pending requests: `requestId → { resolve, host, method, path }`
   - When Telegram callback received, resolve the corresponding promise
   - Timeout after configurable period (e.g., 5 minutes) → reject

## Implementation Steps

1. **Create certificate generation script**
   - Generate CA key/cert
   - Generate server key/cert signed by CA
   - Store in `certs/` directory

2. **Create config.ts**
   - Load/save proxy-config.json
   - Helper functions for checking/adding grants/rejections

3. **Create proxy.ts**
   - HTTPS server with TLS termination
   - Request interception logic
   - Integration with Telegram approval

4. **Modify index.ts**
   - Add approval request function
   - Handle approval callbacks
   - Start both bot and proxy

5. **Create initial proxy-config.json**
   - Empty template

## Configuration Details

- **Ports**: 80 (HTTP) and 443 (HTTPS)
- **Colima setup**: `dnsHosts: {github.com: host.lima.internal}`
- **Timeout**: 5 minutes → reject with HTTP 403 + count as one-time rejection

## Verification
1. Generate certificates: `bun run generate-certs.ts`
2. Install CA cert in Colima VM / system
3. Configure Colima: `dnsHosts: {github.com: host.lima.internal}`
4. Start: `bun --watch run index.ts`
5. Make request with secret token → should see Telegram message
6. Approve/reject → request completes accordingly
7. Timeout test → should get 403 and logged as once-rejection
8. Check proxy-config.json for saved decisions
