import { db } from "@/lib/db";
import type { JsonContract } from "@/modules/execution/contract";

/**
 * The slice of the application's inventory given to generators: bounded, and limited to
 * facts the sources state (documented contracts and statuses, stated protection, written
 * requirements). Generated cases reference these items by key in `coverage.requirements`.
 */

export type InventoryEndpoint = {
  key: string;
  method: string;
  path: string;
  title: string;
  protected: boolean | null;
  parameters: Array<{ name: string; in: string; required: boolean; schema?: JsonContract }>;
  responses: Record<string, { contract: JsonContract | null }>;
};

export type InventoryContext = {
  endpoints: InventoryEndpoint[];
  routes: Array<{ key: string; protected: boolean | null }>;
  requirements: Array<{ key: string; title: string; criteria: string[]; rules: string[] }>;
  workflows: Array<{ key: string; title: string; steps: Array<{ keyword: string; text: string }> }>;
  roles: string[];
};

/** Pseudo-features for inventory-derived cases that don't belong to one discovered feature. */
export const INVENTORY_FEATURES = { api: "API contracts", access: "Access control", rules: "Business rules", workflows: "Workflows" } as const;
export const INVENTORY_FEATURE_NAMES = new Set<string>(Object.values(INVENTORY_FEATURES));

const LIMITS = { endpoints: 40, routes: 60, requirements: 40, workflows: 20, roles: 20 };

export async function loadInventoryContext(applicationId: string): Promise<InventoryContext | null> {
  const items = await db().inventoryItem.findMany({ where: { applicationId, active: true }, orderBy: [{ kind: "asc" }, { key: "asc" }], take: 1_000 });
  if (!items.length) return null;
  const details = (d: unknown) => (d ?? {}) as Record<string, unknown>;
  return {
    endpoints: items
      .filter((i) => i.kind === "API_ENDPOINT")
      .slice(0, LIMITS.endpoints)
      .map((i) => {
        const d = details(i.details);
        const [method, ...rest] = i.key.split(" ");
        return {
          key: i.key,
          method,
          path: rest.join(" "),
          title: i.title,
          protected: i.protected,
          parameters: (d.parameters as InventoryEndpoint["parameters"]) ?? [],
          responses: (d.responses as InventoryEndpoint["responses"]) ?? {},
        };
      }),
    routes: items.filter((i) => i.kind === "ROUTE").slice(0, LIMITS.routes).map((i) => ({ key: i.key, protected: i.protected })),
    requirements: items
      .filter((i) => i.kind === "REQUIREMENT")
      .slice(0, LIMITS.requirements)
      .map((i) => ({ key: i.key, title: i.title, criteria: ((details(i.details).criteria as string[]) ?? []).slice(0, 10), rules: ((details(i.details).rules as string[]) ?? []).slice(0, 10) })),
    workflows: items
      .filter((i) => i.kind === "WORKFLOW")
      .slice(0, LIMITS.workflows)
      .map((i) => ({ key: i.key, title: i.title, steps: ((details(i.details).steps as InventoryContext["workflows"][number]["steps"]) ?? []).slice(0, 20) })),
    roles: items.filter((i) => i.kind === "ROLE").slice(0, LIMITS.roles).map((i) => i.key),
  };
}
