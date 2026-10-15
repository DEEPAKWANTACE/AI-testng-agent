/**
 * Serves the Demo Shop for trying discovery locally:  npm run demo:target
 *
 * Because it runs on localhost, the worker only crawls it when its host:port is listed in
 * DISCOVERY_PRIVATE_ALLOWLIST (development only). The canary must never receive requests.
 */
import { DEMO_CREDENTIALS, startCanary, startDemoApp } from "./target-app";

async function main() {
  // In a container the platform provides PORT and the app must listen on all interfaces.
  const port = Number(process.env.PORT ?? process.env.DEMO_PORT ?? 4100);
  const host = process.env.DEMO_HOST ?? "127.0.0.1";
  const canary = await startCanary(port + 1);
  const app = await startDemoApp({ port, host, canaryPort: canary.port });

  console.log(`Demo Shop:   ${app.url}  (sign in: ${DEMO_CREDENTIALS.email} / ${DEMO_CREDENTIALS.password})`);
  console.log(`Canary:      http://127.0.0.1:${canary.port}  (must stay at 0 requests)`);
  setInterval(() => {
    if (canary.requests.length) console.warn(`⚠ canary received ${canary.requests.length} request(s):`, canary.requests);
  }, 5_000);
}

void main();
