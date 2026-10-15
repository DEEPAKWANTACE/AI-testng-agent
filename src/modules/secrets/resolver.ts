import "server-only";
import { providerForReference, SECRET_REFERENCE_FORMATS } from "./schemas";

function envVariableName(reference: string): string | null {
  return SECRET_REFERENCE_FORMATS.ENV.pattern.test(reference) ? reference.slice("env://".length) : null;
}

/**
 * Resolves a secret reference to its value at the moment it's needed (e.g. by a future
 * test runner). Values are never persisted, logged or sent to the browser.
 * Only the `env://` provider is wired up; others need a client for that secret manager.
 */
export async function resolveSecret(reference: string): Promise<string> {
  const provider = providerForReference(reference);
  if (provider === "ENV") {
    const name = envVariableName(reference);
    if (!name) throw new Error("Only QA_-prefixed environment variables can be referenced");
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`Secret ${reference} is not set in the server environment`);
    return value;
  }
  throw new Error(`Secret provider ${provider ?? "unknown"} is not configured on this server`);
}

export type SecretAvailability = "available" | "missing" | "external";

/** For the UI: whether a reference can be resolved, without revealing the value. */
export function secretAvailability(reference: string): SecretAvailability {
  if (providerForReference(reference) !== "ENV") return "external";
  const name = envVariableName(reference);
  return name && process.env[name] ? "available" : "missing";
}
