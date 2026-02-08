import { $ } from "bun";
import { mkdir } from "node:fs/promises";

const CERTS_DIR = "./certs";

async function generateCerts() {
  console.log("Creating certs directory...");
  await mkdir(CERTS_DIR, { recursive: true });

  console.log("Generating CA private key...");
  await $`openssl genrsa -out ${CERTS_DIR}/ca.key 4096`;

  console.log("Generating CA certificate...");
  await $`openssl req -new -x509 -days 3650 -key ${CERTS_DIR}/ca.key -out ${CERTS_DIR}/ca.crt -subj "/CN=VM HTTP Proxy CA/O=VM HTTP Proxy/C=US"`;

  console.log("Generating server private key...");
  await $`openssl genrsa -out ${CERTS_DIR}/server.key 2048`;

  console.log("Generating server certificate signing request...");
  await $`openssl req -new -key ${CERTS_DIR}/server.key -out ${CERTS_DIR}/server.csr -subj "/CN=*/O=VM HTTP Proxy/C=US"`;

  const extFile = `${CERTS_DIR}/server.ext`;
  await Bun.write(
    extFile,
    `authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = *
DNS.2 = *.github.com
DNS.3 = github.com
DNS.4 = api.github.com
DNS.5 = *.anthropic.com
DNS.6 = anthropic.com
DNS.7 = api.anthropic.com
DNS.8 = localhost
IP.1 = 127.0.0.1
`,
  );

  console.log("Signing server certificate with CA...");
  await $`openssl x509 -req -in ${CERTS_DIR}/server.csr -CA ${CERTS_DIR}/ca.crt -CAkey ${CERTS_DIR}/ca.key -CAcreateserial -out ${CERTS_DIR}/server.crt -days 365 -extfile ${extFile}`;

  console.log("Cleaning up temporary files...");
  await $`rm ${CERTS_DIR}/server.csr ${CERTS_DIR}/server.ext ${CERTS_DIR}/ca.srl`.nothrow();

  console.log("\n✓ Certificates generated successfully!");
  console.log(`\nCA certificate: ${CERTS_DIR}/ca.crt`);
  console.log(`Server certificate: ${CERTS_DIR}/server.crt`);
  console.log(`Server key: ${CERTS_DIR}/server.key`);
  console.log("\nTo use the proxy, install the CA certificate in your system/VM:");
  console.log(`  - Copy ${CERTS_DIR}/ca.crt to your VM`);
  console.log("  - Install it as a trusted root CA");
}

generateCerts().catch(console.error);
