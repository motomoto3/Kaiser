/**
 * Generates Polymarket CLOB API credentials via WalletConnect.
 * Scan the QR code with any mobile wallet (MetaMask, Rainbow, Trust, etc.)
 *
 * Requires a free WalletConnect project ID:
 *   → https://cloud.reown.com  (sign up, create project, copy Project ID)
 *
 * Usage:
 *   WALLETCONNECT_PROJECT_ID=abc123 node gen-creds-wc.mjs
 */

import SignClient        from "@walletconnect/sign-client";
import qrcode            from "qrcode-terminal";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const DIR      = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(DIR, ".env");

// ── Config ────────────────────────────────────────────────────────────────────
const PROJECT_ID   = process.env.WALLETCONNECT_PROJECT_ID?.trim();
const CLOB_HOST    = "https://clob.polymarket.com";
const POLYGON_ID   = 137;
const MSG_TO_SIGN  = "This message attests that I control the given wallet";

if (!PROJECT_ID) {
  console.error([
    "",
    "  Missing WALLETCONNECT_PROJECT_ID.",
    "  Get a free one in ~30 seconds:",
    "    1. Go to https://cloud.reown.com",
    "    2. Sign up / log in → New Project → any name → copy Project ID",
    "    3. Run:  WALLETCONNECT_PROJECT_ID=<id> node gen-creds-wc.mjs",
    "",
  ].join("\n"));
  process.exit(1);
}

// ── WalletConnect session ─────────────────────────────────────────────────────
console.log("Initialising WalletConnect…");
const client = await SignClient.init({
  projectId: PROJECT_ID,
  metadata: {
    name:        "Kaiser Live – credential setup",
    description: "One-time Polymarket CLOB credential generation",
    url:         "http://localhost",
    icons:       [],
  },
});

const { uri, approval } = await client.connect({
  requiredNamespaces: {
    eip155: {
      methods:  ["eth_signTypedData_v4"],
      chains:   [`eip155:${POLYGON_ID}`],
      events:   [],
    },
  },
});

if (!uri) { console.error("Failed to generate pairing URI."); process.exit(1); }

// ── Show QR code ──────────────────────────────────────────────────────────────
console.log("\nScan this QR code with your wallet (MetaMask, Rainbow, Trust…)\n");
qrcode.generate(uri, { small: true });
console.log("\nOr paste this URI into your wallet app:");
console.log(uri, "\n");
console.log("Waiting for connection…");

const session  = await approval();
const accounts = session.namespaces.eip155?.accounts ?? [];
if (!accounts.length) { console.error("No accounts returned."); process.exit(1); }

const address   = accounts[0].split(":")[2];   // "eip155:137:0x..." → "0x..."
const chainRef  = `eip155:${POLYGON_ID}`;
console.log("Connected:", address);

// ── Build EIP-712 payload ─────────────────────────────────────────────────────
const timestamp = Math.floor(Date.now() / 1000).toString();
const typedData = JSON.stringify({
  domain: { name: "ClobAuthDomain", version: "1", chainId: POLYGON_ID },
  types: {
    EIP712Domain: [
      { name: "name",    type: "string"  },
      { name: "version", type: "string"  },
      { name: "chainId", type: "uint256" },
    ],
    ClobAuth: [
      { name: "address",   type: "address" },
      { name: "timestamp", type: "string"  },
      { name: "nonce",     type: "uint256" },
      { name: "message",   type: "string"  },
    ],
  },
  primaryType: "ClobAuth",
  message: { address, timestamp, nonce: 0, message: MSG_TO_SIGN },
});

// ── Request signature ─────────────────────────────────────────────────────────
console.log("\nApprove the signing request in your wallet…");
const signature = await client.request({
  topic:   session.topic,
  chainId: chainRef,
  request: { method: "eth_signTypedData_v4", params: [address, typedData] },
});
console.log("Signature received.");

// ── Call Polymarket CLOB to create/derive credentials ─────────────────────────
const headers = {
  POLY_ADDRESS:   address,
  POLY_SIGNATURE: signature,
  POLY_TIMESTAMP: timestamp,
  POLY_NONCE:     "0",
  "Content-Type": "application/json",
  Accept:         "application/json",
};

// Try deriving existing key first; fall back to creating a new one
let creds;
const deriveRes = await fetch(`${CLOB_HOST}/auth/api-key`, { headers });
if (deriveRes.ok) {
  creds = await deriveRes.json();
} else {
  const createRes = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "POST", headers });
  if (!createRes.ok) {
    const body = await createRes.text();
    console.error("CLOB API error:", createRes.status, body);
    process.exit(1);
  }
  creds = await createRes.json();
}

if (!creds?.apiKey) {
  console.error("Unexpected response:", JSON.stringify(creds));
  process.exit(1);
}

console.log("\n── Credentials ───────────────────────────────");
console.log("API_KEY:    ", creds.apiKey);
console.log("SECRET:     ", creds.secret);
console.log("PASSPHRASE: ", creds.passphrase);

// ── Patch .env ────────────────────────────────────────────────────────────────
let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
const set = (src, key, val) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(src) ? src.replace(re, `${key}=${val}`) : src + `\n${key}=${val}`;
};
env = set(env, "POLYMARKET_API_KEY",    creds.apiKey);
env = set(env, "POLYMARKET_SECRET",     creds.secret);
env = set(env, "POLYMARKET_PASSPHRASE", creds.passphrase);
writeFileSync(ENV_FILE, env);
console.log("\n✓ .env updated — restart the bot to activate open-order fetching.");

await client.disconnect({ topic: session.topic, reason: { code: 0, message: "done" } });
process.exit(0);
