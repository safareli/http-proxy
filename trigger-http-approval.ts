// Simple script to trigger a Telegram approval request through the proxy.
// Usage: bun trigger-http-approval.ts
//
// Make sure the proxy is running first (bun index.ts).

const FAKE_TOKEN =
  "github_pat_XXXXXXXXXXXXXXXXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const res = await fetch("https://127.0.0.1:443/repos/my_org/my_app/pulls", {
  headers: {
    Host: "api.github.com",
    Authorization: `Bearer ${FAKE_TOKEN}`,
    Accept: "application/vnd.github+json",
  },
  tls: { rejectUnauthorized: false },
});

console.log(`Status: ${res.status}`);
console.log(`Body: ${await res.text()}`);
