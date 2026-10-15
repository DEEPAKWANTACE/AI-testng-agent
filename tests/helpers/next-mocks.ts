/**
 * Minimal stand-ins for Next.js request APIs so Server Actions can be called directly.
 * Everything else — validation, authentication, authorization, Prisma, Postgres — is real.
 */
import { beforeEach, vi } from "vitest";

export const cookieJar = new Map<string, { value: string; options?: Record<string, unknown> }>();
export const requestHeaders = new Headers();

/** Thrown by the mocked `redirect()`, mirroring how Next interrupts rendering. */
export class RedirectError extends Error {
  constructor(public readonly location: string) {
    super(`NEXT_REDIRECT:${location}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => cookieJar.set(name, { value, options }),
    delete: (name: string) => cookieJar.delete(name),
  }),
  headers: async () => requestHeaders,
}));

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new RedirectError(location);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

beforeEach(() => {
  cookieJar.clear();
  for (const key of [...requestHeaders.keys()]) requestHeaders.delete(key);
});
