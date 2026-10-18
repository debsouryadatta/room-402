// Load .env (written by Stripe Projects) and .env.local (Stripe test key). Import this first.
for (const file of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file missing: fine (on CreateOS the env vars are set on the deployment)
  }
}
export {};

/** If set, starting runs, approving spend and lights-out need this token (header x-admin-token; the page reads it from /#key=...). */
export const ADMIN_TOKEN = process.env.ROOM402_ADMIN_TOKEN || "";

/** ROOM402_PUBLIC_CONTROLS=1 opens operator actions to everyone (hackathon demo mode). */
export const PUBLIC_CONTROLS = process.env.ROOM402_PUBLIC_CONTROLS === "1";

export const PORT = Number(process.env.PORT || 3000);
/** Where the agent loop reaches the Hint Shop and the Door (same process, real HTTP). */
export const BASE_URL = process.env.ROOM402_BASE_URL || `http://127.0.0.1:${PORT}`;
