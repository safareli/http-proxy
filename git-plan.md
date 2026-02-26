# Plan: Merge Git Proxy into HTTP Proxy

## Goal

Bring git-proxy functionality into http-proxy, replacing the git-proxy's
"pre-configure everything up front" model with the http-proxy's incremental
Telegram approval flow. The agent uses `https://github.com/owner/repo.git` as
the remote — the proxy transparently intercepts git operations, asks for
approval via Telegram as needed, and manages local bare repos + upstream sync.

---

## Current State

### git-proxy
- Standalone HTTP server (port 8080) wrapping `git-http-backend`
- Maintains local bare repos, syncs with upstream via SSH
- Pre-receive hook validates: branch names, protected paths, force push, upstream divergence
- Pushes to upstream synchronously from within the hook
- **All repos and rules must be pre-configured** in `config.json`

### http-proxy
- HTTPS MITM proxy (ports 80/443) with TLS termination & SNI
- Detects fake secrets in headers, asks Telegram for approval
- Saves permanent grants/rejections to `proxy-config.json`
- Supports OpenAPI-aware pattern suggestions and GraphQL field-level approval
- **Incrementally builds policy** — unknown requests trigger Telegram approval

---

## Target UX

### Read (clone/fetch) of a new repo
```
Agent: git clone https://github.com/owner/repo.git
Proxy: "🔒 Allow cloning owner/repo?"
       [✓ Allow forever]  [✗ Reject once]
User taps "✓ Allow forever" →
  - Proxy creates local bare repo, fetches from upstream
  - Adds entry to config: repos.owner/repo = { allowed_read: true, ... }
  - Clone succeeds
Future clones/fetches of owner/repo → auto-allowed (in config)
```

### Read of an already-allowed repo
No Telegram message. Proxy fetches from upstream, serves via git-http-backend.

### Push a tag
```
Agent: git push origin v1.0.0
Proxy: "🔒 Allow pushing tag v1.0.0 to owner/repo?"
       [✓ Once]  [✗ Once]
```
Tag pushes are **always asked, never approved forever**.

### Push a branch (with slash, e.g. `agent/feature-x`)
```
Agent: git push origin agent/feature-x
Proxy: "🔒 Allow pushing branch agent/feature-x to owner/repo?"
       [✓ Once]  [✗ Once]  [✗ Forever ▸]
       [✓ agent/feature-x]         ← exact branch forever
       [✓ agent/*]                 ← prefix pattern forever
       [✓ * (except main)]        ← allow all, auto-reject base branch
       [✓ *]                       ← allow everything including main
```
The `* (except main)` option adds `*` to `allowed_push_branches` **and**
adds `main` (the repo's `base_branch`) to `rejected_push_branches`.
Since rejections are checked before grants, pushes to main are still blocked.

The plain `*` option adds `*` to `allowed_push_branches` with no rejection —
truly allows pushing to any branch. Listed last as the most permissive option.

### Push a branch (no slash, e.g. `dev`)
```
Agent: git push origin dev
Proxy: "🔒 Allow pushing branch dev to owner/repo?"
       [✓ Once]  [✗ Once]  [✗ Forever ▸]
       [✓ dev]                         ← exact branch forever
       [✓ * (except main)]            ← allow all, auto-reject base branch
       [✓ *]                           ← allow everything including main
```

### Branch deletion
```
Agent: git push origin :agent/feature-x
Proxy: "🔒 Allow deleting branch agent/feature-x from owner/repo?"
       [✓ Once]  [✗ Once]
```
Branch deletion is **always asked, never approved forever** (one-time only).

### Force push
```
Agent: git push --force origin agent/feature-x
Proxy: "🔒 Allow force push to branch agent/feature-x in owner/repo?"
       [✓ Once]  [✗ Once]
```
Force push is **always asked, never approved forever** (one-time only).
This replaces the static `force_push: "deny"` config — the user decides
each time via Telegram.

### Protected paths
Remain **manually configured** per repo. If a push touches protected paths,
it is rejected immediately (no Telegram approval) with a clear error message,
same as current git-proxy.

---

## Config Schema

Git config lives alongside `secrets` under each host in `proxy-config.json`:

```jsonc
{
  "api.github.com": {
    "secrets": [ /* existing API secret configs */ ],
    "graphqlEndpoints": ["/graphql"],
    "openApiSpec": { "url": "..." }
  },
  "github.com": {
    "secrets": [
      // optional — if the agent also makes non-git HTTPS requests to github.com
    ],
    "git": {
      // SSH key for upstream fetch/push
      "ssh_key_path": "/run/secrets/github-deploy-key",

      "repos_dir": "./git-repos",

      "repos": {
        // Entries are created/updated by Telegram approval flow
        "owner/repo": {
          "upstream": "git@github.com:owner/repo.git",
          "base_branch": "main",
          // Built incrementally via Telegram approvals:
          "allowed_push_branches": ["agent/*", "feature/*"],
          "rejected_push_branches": [],
          // Manually configured:
          "protected_paths": [".github/**", "*.nix"]
        }
      }
    }
  }
}
```

When a user approves "Allow forever" for a new repo, the proxy writes a new
entry under `git.repos`. When a user approves a branch pattern, it gets added
to `allowed_push_branches`. Rejections go to `rejected_push_branches`.

---

## Architecture

```
┌─────────────┐  https://github.com/...  ┌────────────────────────────────────┐
│  Agent VM   │ ────────────────────────▶ │  http-proxy (ports 80/443)         │
│             │                           │                                    │
│  git clone  │                           │  1. TLS termination (SNI)          │
│  git push   │                           │  2. Is this a git operation?       │
│  curl API   │                           │     YES → git handler              │
│             │                           │     NO  → existing http/gql flow   │
└─────────────┘                           │                                    │
                                          │  ┌──────────────────────────────┐  │
                                          │  │ Git Handler                  │  │
                                          │  │                              │  │
                                          │  │  • Parse owner/repo from URL │  │
                                          │  │  • Repo known? If not →      │  │
                                          │  │    Telegram: allow clone?    │  │
                                          │  │  • Acquire per-repo lock     │  │
                                          │  │  • Fetch from upstream       │  │
                                          │  │  • Proxy to git-http-backend │  │
                                          │  │                              │  │
                                          │  │  pre-receive hook:           │  │
                                          │  │   • Validate protected paths │  │
                                          │  │   • Check force push         │  │
                                          │  │   • For branch/tag:          │──────▶ Telegram
                                          │  │     write to Unix socket →  │         approval
                                          │  │     Telegram approval        │◀──────
                                          │  │   • Push to upstream         │──────▶ GitHub
                                          │  │                              │  │
                                          │  └──────────────────────────────┘  │
                                          └────────────────────────────────────┘
```

### Git Operation Detection

Git smart HTTP protocol uses these URL patterns:
- `GET  /<path>.git/info/refs?service=git-upload-pack`  (fetch/clone discovery)
- `POST /<path>.git/git-upload-pack`                     (fetch/clone data)
- `GET  /<path>.git/info/refs?service=git-receive-pack` (push discovery)
- `POST /<path>.git/git-receive-pack`                    (push data)

Also handle URLs without `.git` suffix (GitHub supports both):
- `GET  /<owner>/<repo>/info/refs?service=...`
- etc.

Detection: If the host has a `git` config section, check if the URL matches
these patterns. If yes → route to git handler. If no → normal http-proxy flow.

### Pre-receive Hook ↔ Main Process Communication

The pre-receive hook runs as a **child process** of git-http-backend. It needs
to request Telegram approval from the main proxy process. Solution:

1. The proxy creates a **Unix domain socket** (e.g. `<repos_dir>/.hook.sock`)
   on startup and listens for hook connections.
2. The socket path is passed to hooks via env var: `GIT_PROXY_SOCK=<path>`
3. The hook connects to the socket and writes a newline-delimited JSON message:
   ```json
   {"repo":"owner/repo","type":"branch","ref":"agent/feature-x"}
   ```
4. The main process reads the message, sends a Telegram approval request, waits
   for the user's response, then writes the result back on the same connection:
   ```json
   {"allowed":true,"pattern":"agent/*"}
   ```
5. The hook reads the response and exits 0 (allow) or 1 (reject).

Simple, no port conflicts, no HTTP overhead, automatically scoped to localhost.

---

## Implementation Phases

### Phase 1: Config Schema & Git Operation Detection

**Files to modify:** `config.ts`
**New files:** `git-config.ts`

- [x] Extend `HostConfig` with optional `git` field (Zod-validated)
- [x] Git config type: `{ ssh_key_path?, repos_dir, repos: Record<string, RepoConfig> }`
- [x] `RepoConfig`: `{ upstream, base_branch, allowed_push_branches, rejected_push_branches, protected_paths }`
- [x] Add `isGitRequest(url: URL): boolean` — checks URL pattern
- [x] Add `parseGitRequest(url: URL): { owner: string, repo: string, operation: "upload-pack" | "receive-pack", phase: "discovery" | "data" } | null`
- [x] Add save logic that persists git config changes (new repos, new branch patterns) to `proxy-config.json`

### Phase 2: Git Backend Integration

**Files to port/adapt from git-proxy:** `git-backend.ts`, `utils.ts` (git helpers, locking, glob matching)

- [x] Port `git-backend.ts` (CGI env building, git-http-backend execution, CGI response parsing) into http-proxy
- [x] Port git helper utilities: `git()`, `withLock()`, `matchesAnyPattern()`, `branchMatchesPattern()`
- [x] Port repo initialization logic: `initializeRepo()` (bare repo creation, remote setup, fetch refspec, HEAD setup)
- [x] Port SSH env setup from git-proxy (`setupSshEnv`)
- [x] Wire into proxy: when `isGitRequest()` matches, route to git handler instead of normal http flow

### Phase 3: Telegram Approval for Repo Access (Clone/Fetch)

**Files to modify:** `proxy.ts`, `index.ts`

- [x] In the git handler, before serving a clone/fetch:
  - If repo is in config → proceed (fetch from upstream, serve)
  - If repo is **not** in config → trigger Telegram approval
- [x] Telegram message: "Allow cloning `owner/repo`?" with buttons:
  - `[✓ Allow forever]` — creates config entry, initializes repo, proceeds
  - `[✗ Reject once]` — returns error to git client
- [x] On "Allow forever": create repo entry in config, call `initializeRepo()`, save config, proceed with clone
- [x] Handle timeout (~4 min) → reject

### Phase 4: Pre-receive Hook with Telegram Approval for Pushes

**Files to create:** `git-hooks.ts` (hook logic), `git-hook-socket.ts` (Unix socket server)
**Files to port/adapt:** `hooks.ts` from git-proxy

- [x] **Internal approval socket** (Unix domain socket):
  - Proxy listens on `<repos_dir>/.hook.sock`
  - Hook connects, writes JSON request `{ repo, type, ref, details }`, reads JSON response `{ allowed, pattern? }`
  - Main process triggers Telegram message on each incoming connection, blocks until user responds, writes result back
  - Socket path passed to hooks via env var `GIT_PROXY_SOCK`

- [x] **Pre-receive hook script** (installed in each bare repo):
  - Reads stdin (ref updates)
  - For each ref update:
    1. Validate protected paths (reject immediately if violated — no Telegram)
    2. Detect force push → call socket → ask once (never forever)
    3. Detect branch deletion → call socket → ask once (never forever)
    4. Determine ref type:
       - **Tag** (`refs/tags/*`): call socket → always ask, never "forever"
       - **Branch** (`refs/heads/*`):
         - Check `rejected_push_branches` → reject immediately if matched
         - Check `allowed_push_branches` → allow if matched
         - Otherwise → call socket → Telegram approval with pattern options
    5. If all approved → push to upstream

- [x] **Telegram message for branch push:**
  - Parse branch name for slash segments
  - Generate pattern options (most specific → least specific):
    - Branch has `/`: exact match → `prefix/*` → `* (except <base_branch>)` → `*`
    - Branch has no `/`: exact match → `* (except <base_branch>)` → `*`
    - `* (except <base_branch>)`: adds `*` to allowed **and** `<base_branch>` to rejected
    - `*`: adds `*` to allowed with no rejection (fully permissive)
  - Buttons: `[✓ Once] [✗ Once] [✗ Forever ▸] [✓ <pattern>...]`
  - "✓ pattern" → add to `allowed_push_branches` in config
  - "✗ pattern" → add to `rejected_push_branches` in config

- [x] **Telegram message for tag push:**
  - Buttons: `[✓ Once] [✗ Once]` only (no forever options)

- [x] **Telegram message for branch deletion:**
  - "Allow deleting branch `<branch>` from `owner/repo`?"
  - Buttons: `[✓ Once] [✗ Once]` only (no forever options)

- [x] **Telegram message for force push:**
  - "Allow force push to branch `<branch>` in `owner/repo`?"
  - Buttons: `[✓ Once] [✗ Once]` only (no forever options)

### Phase 5: End-to-End Wiring & Testing

- [x] Wire everything together in `proxy.ts`:
  - `handleRequest()` checks `isGitRequest()` → routes to `handleGitRequest()`
  - `handleGitRequest()` handles clone/fetch approval + git-http-backend proxying
  - Internal approval API runs on startup
- [x] Ensure cert generation covers `github.com` (or whatever git host is configured)
- [x] Automated end-to-end coverage in `git/e2e.test.ts` (including migrated scenarios from legacy `git-proxy` tests):
  - Clone unknown repo → Telegram approval → success
  - Clone known repo → no approval needed → success
  - Clone checks out configured base branch
  - Push to unapproved branch → Telegram approval → approve with pattern → success
  - Push to approved branch → no approval needed → success
  - Push tag → always asked → success
  - Push modifying protected path → immediate rejection (no Telegram)
  - Push modifying protected path then reverting → success
  - Push to rejected branch → immediate rejection (no Telegram)
  - Force push → Telegram ask once → success/rejection
  - Branch deletion → Telegram ask once → success/rejection
  - Timeout → rejection (socket-level timeout tests)
  - Client disconnect flow handled in approval handlers

### Phase 6: Cleanup & Migration

- [x] Update `proxy-config.example.json` with git config example
- [x] Update `README.md` with git proxy documentation
- [x] Update `/etc/hosts` setup instructions (need `github.com` pointing to proxy)
- [x] Remove standalone git-proxy dependency from runtime/deployment path (legacy `git-proxy/` kept only for reference/tests)

---

## Key Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Git config lives under host entry in proxy-config.json | Natural fit — github.com has both API secrets and git config |
| Pre-receive hook talks to main process via Unix domain socket | Simple IPC; no port conflicts; hook stays stateless; reuses existing Telegram bot |
| Tag pushes are always asked (never forever) | Tags are immutable releases — each one deserves explicit approval |
| Branch deletion is always asked (never forever) | Destructive operation — each one deserves explicit approval |
| Force push is always asked (never forever) | Rewrites history — each one deserves explicit approval; replaces static `force_push: deny` config |
| `*` option shown as `* (except main)` and auto-rejects base branch | Convenient catch-all that stays safe — rejections are checked before grants |
| Protected paths remain manual config | Hard to express "don't change these files" incrementally; safer to require up-front thought |
| Repos are initialized lazily (on first approved access) | No need to pre-configure; fits the incremental approval model |
| Reads approved forever create a persistent config entry | Must maintain local bare repo for the proxy to work; one-time read doesn't make sense |

---

## File Structure (http-proxy after merge)

```
http-proxy/
├── index.ts                 # Entry point: Telegram bot + proxy + hook socket startup
├── proxy.ts                 # Main request handler (HTTP + GraphQL + Git routing)
├── config.ts                # Config loading/saving (extended with git schema)
├── certs.ts                 # TLS certificate management
├── graphql.ts               # GraphQL parsing & pattern matching
├── openapi.ts               # OpenAPI spec loading & pattern generation
│
├── git/                     # New: git proxy module
│   ├── handler.ts           # Git request detection, routing, clone/fetch approval
│   ├── backend.ts           # git-http-backend CGI execution (ported from git-proxy)
│   ├── hooks.ts             # Pre-receive hook logic (branch/tag validation + approval)
│   ├── repo.ts              # Repo initialization, upstream sync, SSH env
│   ├── hook-socket.ts       # Unix domain socket for hook↔main process communication
│   └── utils.ts             # Git helpers (git cmd, locking, glob matching)
│
├── proxy-config.json        # Runtime config (extended with git entries)
├── proxy-config.example.json
├── git-repos/               # Local bare repositories (created on demand)
│   └── owner/
│       └── repo.git/
└── ...
```

---

## Open Questions

1. ~~**Upstream auth: SSH key vs HTTPS token?**~~ Resolved — SSH only.
   No token auth needed: the agent talks HTTPS to the proxy, the proxy
   talks SSH to upstream GitHub for both fetch and push.

2. **Multiple git hosts?** The design naturally supports multiple hosts
   (e.g., `github.com`, `gitlab.com`) — each gets its own `git` config section.

3. ~~**Internal API port.**~~ Resolved — using Unix domain socket at
   `<repos_dir>/.hook.sock`.

4. ~~**Branch deletion.**~~ Resolved — yes, always requires one-time
   Telegram approval (never approved forever). Already described in
   Target UX section above.

5. ~~**Force push to allowed branch.**~~ Resolved — force push is always
   asked via Telegram (one-time), regardless of branch approval status.
