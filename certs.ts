import { $ } from "bun";
import { mkdir } from "node:fs/promises";

const CERTS_DIR = "./certs";
const DOMAINS_DIR = `${CERTS_DIR}/domains`;

export interface DomainCert {
  cert: string;
  key: string;
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function ensureCA(): Promise<void> {
  await mkdir(CERTS_DIR, { recursive: true });

  const caKeyPath = `${CERTS_DIR}/ca.key`;
  const caCrtPath = `${CERTS_DIR}/ca.crt`;

  if (await fileExists(caKeyPath) && await fileExists(caCrtPath)) {
    console.log("CA certificate already exists");
    return;
  }

  console.log("Generating CA private key...");
  await $`openssl genrsa -out ${caKeyPath} 4096`;

  console.log("Generating CA certificate...");
  await $`openssl req -new -x509 -days 3650 -key ${caKeyPath} -out ${caCrtPath} -subj "/CN=VM HTTP Proxy CA/O=VM HTTP Proxy/C=US"`;

  console.log("CA certificate generated successfully");
  console.log(`Install ${caCrtPath} as a trusted root CA on your VM`);
}

export async function ensureDomainCert(domain: string): Promise<DomainCert> {
  await mkdir(DOMAINS_DIR, { recursive: true });

  const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, "_");
  const keyPath = `${DOMAINS_DIR}/${safeDomain}.key`;
  const crtPath = `${DOMAINS_DIR}/${safeDomain}.crt`;

  if (await fileExists(keyPath) && await fileExists(crtPath)) {
    console.log(`Certificate for ${domain} already exists`);
    return {
      cert: await Bun.file(crtPath).text(),
      key: await Bun.file(keyPath).text(),
    };
  }

  console.log(`Generating certificate for ${domain}...`);

  const caKeyPath = `${CERTS_DIR}/ca.key`;
  const caCrtPath = `${CERTS_DIR}/ca.crt`;

  if (!await fileExists(caKeyPath) || !await fileExists(caCrtPath)) {
    throw new Error("CA certificate not found. Run ensureCA() first.");
  }

  // Generate domain private key
  await $`openssl genrsa -out ${keyPath} 2048`;

  // Generate CSR
  const csrPath = `${DOMAINS_DIR}/${safeDomain}.csr`;
  await $`openssl req -new -key ${keyPath} -out ${csrPath} -subj "/CN=${domain}/O=VM HTTP Proxy/C=US"`;

  // Create extension file for SAN
  const extPath = `${DOMAINS_DIR}/${safeDomain}.ext`;
  await Bun.write(
    extPath,
    `authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${domain}
`,
  );

  // Sign the certificate with CA
  await $`openssl x509 -req -in ${csrPath} -CA ${caCrtPath} -CAkey ${caKeyPath} -CAcreateserial -out ${crtPath} -days 365 -extfile ${extPath}`;

  // Cleanup temporary files
  await $`rm ${csrPath} ${extPath}`.nothrow();

  console.log(`Certificate for ${domain} generated successfully`);

  return {
    cert: await Bun.file(crtPath).text(),
    key: await Bun.file(keyPath).text(),
  };
}

export async function ensureAllDomainCerts(
  domains: string[],
): Promise<Record<string, DomainCert>> {
  await ensureCA();

  const certs: Record<string, DomainCert> = {};

  for (const domain of domains) {
    certs[domain] = await ensureDomainCert(domain);
  }

  return certs;
}
