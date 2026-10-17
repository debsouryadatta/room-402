// Load .env (written by Stripe Projects) and .env.local (Stripe test key). Import this first.
for (const file of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file missing: fine (on CreateOS the env vars are set on the deployment)
  }
}
export {};

export const PORT = Number(process.env.PORT || 3000);
/** Where the agent loop reaches the Hint Shop and the Door (same process, real HTTP). */
export const BASE_URL = process.env.ROOM402_BASE_URL || `http://127.0.0.1:${PORT}`;
