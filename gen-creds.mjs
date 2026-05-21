/**
 * Generates Polymarket CLOB API credentials (key + secret + passphrase)
 * from your wallet private key and writes them to .env.
 *
 * Usage:
 *   PRIVATE_KEY=0x... node gen-creds.mjs
 *
 * The private key never leaves this machine.
 */

import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(DIR, ".env");

const POLYGON_CHAIN_ID = 137;
const CLOB_HOST = "https://clob.polymarket.com";

const privateKey = process.env.PRIVATE_KEY?.trim();
if (!privateKey) {
  console.error("Error: set PRIVATE_KEY=0x... before running this script.");
  process.exit(1);
}

console.log("Connecting to Polymarket CLOB…");
const wallet = new ethers.Wallet(privateKey);
console.log("Wallet address:", wallet.address);

const client = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, wallet);

let creds;
try {
  // Try to derive existing credentials first; create new ones if none exist
  creds = await client.createOrDeriveApiKey();
} catch {
  creds = await client.createApiKey();
}

if (!creds?.key) {
  console.error("Failed to obtain credentials:", creds);
  process.exit(1);
}

console.log("\n── Credentials received ──────────────────────");
console.log("API_KEY:    ", creds.key);
console.log("SECRET:     ", creds.secret);
console.log("PASSPHRASE: ", creds.passphrase);

// Patch .env in place
let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";

function setEnvVar(src, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(src)
    ? src.replace(re, `${key}=${value}`)
    : src + `\n${key}=${value}`;
}

env = setEnvVar(env, "POLYMARKET_API_KEY",    creds.key);
env = setEnvVar(env, "POLYMARKET_SECRET",     creds.secret);
env = setEnvVar(env, "POLYMARKET_PASSPHRASE", creds.passphrase);

writeFileSync(ENV_FILE, env);
console.log("\n.env updated — restart the bot to activate open-order fetching.");
