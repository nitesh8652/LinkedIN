/**
 * Loads .env into process.env.
 *
 * Uses Node's built-in loader (Node >= 20.12) so no dependency is needed,
 * with a small manual parser as a fallback for older runtimes. Required by
 * llm.js before it reads process.env, so any entry point picks the key up.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

function loadManually() {
  const raw = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    // never clobber a variable the shell already set
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(ENV_PATH)) return;
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(ENV_PATH);
    else loadManually();
  } catch {
    try { loadManually(); } catch { /* leave process.env as-is */ }
  }
}

loadEnv();

module.exports = { loadEnv };
