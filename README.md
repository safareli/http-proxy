# vm-http-proxy

HTTPS MITM proxy with Telegram approval flow. Intercepts requests, detects secret tokens, and requires Telegram approval before forwarding sensitive requests.

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Generate CA certificate

```bash
bun run generate-certs.ts
```

This creates:
- `certs/ca.crt` - CA certificate (install this in your VM/system)

Per-domain certificates are generated automatically when the proxy starts, based on hosts in `proxy-config.json`. They are stored in `certs/domains/`.

### 3. Install CA certificate in your VM

Copy `certs/ca.crt` to your VM and install it as a trusted root CA.

For Colima/Lima VMs:
```bash
# Copy cert to VM
limactl copy certs/ca.crt colima:/tmp/ca.crt

# SSH into VM and install
limactl shell colima
sudo cp /tmp/ca.crt /usr/local/share/ca-certificates/vm-proxy-ca.crt
sudo update-ca-certificates
```

### 4. Configure environment variables

Create a `.env` file:

```bash
TELEGRAM_API_TOKEN=your_bot_token
TELEGRAM_OWNER_ID=your_telegram_user_id
REAL_GITHUB_TOKEN=your_actual_github_token
# Add other real secrets as needed
```

### 5. Configure proxy hosts

Edit `proxy-config.json` to add hosts you want to intercept:

```json
{
  "api.github.com": {
    "secret": "FAKE_GITHUB_TOKEN",
    "secretEnvVarName": "REAL_GITHUB_TOKEN",
    "grants": [],
    "rejections": []
  }
}
```

- `secret`: The fake token your VM will use in requests
- `secretEnvVarName`: Environment variable containing the real token
- `grants`: Permanently allowed requests (e.g., `["GET /user", "POST /repos"]`)
- `rejections`: Permanently blocked requests

When you add a new host, just restart the proxy - certificates are generated automatically.

### 6. Configure DNS in Colima

Edit your Colima config (`~/.colima/default/colima.yaml`):

```yaml
dnsHosts:
  api.github.com: host.lima.internal
  # Add other hosts as needed
```

Restart Colima after changes.

### 7. Run the proxy

```bash
bun run index.ts
```

Or with auto-reload:

```bash
bun --watch run index.ts
```

The proxy listens on:
- Port 80 (HTTP)
- Port 443 (HTTPS)

## How it works

1. Request arrives at proxy
2. Logs `METHOD URL` to console
3. Scans all header values for the host's fake secret
4. **If secret NOT found** → Pass through to upstream as-is
5. **If secret found**:
   - Check grants/rejections in config
   - If permanently granted → substitute fake→real secret, forward
   - If permanently rejected → return 403
   - Otherwise → send Telegram message with inline keyboard:
     - Allow once / Allow forever / Reject once / Reject forever
   - Hold request until user responds (5 min timeout → 403)
   - If approved: substitute secret, forward to upstream
   - If rejected: return 403

## Telegram commands

- `/start` - Start the bot
- `/help` - Show help

When an approval is needed, you'll receive a message with 4 buttons:
- **✓ Once** - Allow this request once
- **✓ Forever** - Allow this request pattern permanently
- **✗ Once** - Reject this request once
- **✗ Forever** - Reject this request pattern permanently
