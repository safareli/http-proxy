import { ensureCA } from "./certs";

// Just generate the CA certificate
// Per-domain certificates are generated automatically by the proxy on startup
ensureCA()
  .then(() => {
    console.log("\n✓ CA certificate ready!");
    console.log("\nTo use the proxy, install the CA certificate in your system/VM:");
    console.log("  - Copy ./certs/ca.crt to your VM");
    console.log("  - Install it as a trusted root CA");
    console.log("\nPer-domain certificates will be generated automatically when the proxy starts.");
  })
  .catch(console.error);
