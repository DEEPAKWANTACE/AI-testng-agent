import { z } from "zod";
import { AppEnvironment, AppType } from "@/generated/prisma/enums";
import { optionalText, requiredText } from "@/lib/validation";

const emptyToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);

/**
 * The single origin (plus optional path prefix) the agent is allowed to test.
 * Credentials, query strings and fragments are rejected; the value is normalised.
 */
export const authorizedUrlSchema = z
  .string({ error: "Authorized URL is required" })
  .trim()
  .min(1, "Authorized URL is required")
  .max(2048, "Authorized URL is too long")
  .transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Enter a full URL, e.g. https://staging.example.com" });
      return z.NEVER;
    }
    const problem =
      url.protocol !== "https:" && url.protocol !== "http:"
        ? "Authorized URL must use http or https"
        : url.username || url.password
          ? "Authorized URL must not contain credentials — store them as a secret reference"
          : url.search || url.hash
            ? "Authorized URL must not include a query string or fragment"
            : url.pathname.includes("@")
              ? "Authorized URL must not contain @"
              : null;
    if (problem) {
      ctx.addIssue({ code: "custom", message: problem });
      return z.NEVER;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  });

const SCP_LIKE = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+)$/;

/** https://host/owner/repo, ssh://git@host/owner/repo or git@host:owner/repo — never with credentials. */
export const repoUrlSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(2048, "Repository URL is too long")
    .transform((value, ctx) => {
      if (SCP_LIKE.test(value)) return value;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Use https://host/owner/repo or git@host:owner/repo" });
        return z.NEVER;
      }
      const segments = url.pathname.split("/").filter(Boolean);
      const problem =
        url.protocol === "http:"
          ? "Use https or ssh — plain http repositories aren't allowed"
          : url.protocol === "https:"
            ? url.username || url.password
              ? "Remove the credentials from the URL — use a secret reference for access tokens"
              : null
            : url.protocol === "ssh:"
              ? url.username !== "git" || url.password
                ? "SSH repository URLs must use the git user, e.g. ssh://git@host/owner/repo"
                : null
              : "Use https://host/owner/repo or git@host:owner/repo";
      if (problem || segments.length < 2 || url.search || url.hash) {
        ctx.addIssue({ code: "custom", message: problem ?? "Repository URL must point at a repository, e.g. https://github.com/acme/web" });
        return z.NEVER;
      }
      return `${url.protocol}//${url.username ? `${url.username}@` : ""}${url.host}/${segments.join("/")}`;
    })
    .nullable(),
);

/** Subset of `git check-ref-format` rules sufficient to reject unsafe or invalid names. */
export const branchSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(255, "Branch name is too long")
    .refine(
      (value) =>
        /^[A-Za-z0-9._/-]+$/.test(value) &&
        !/^[-/.]/.test(value) &&
        !/(\/|\.|\.lock)$/.test(value) &&
        !/(\.\.|\/\/|\/\.)/.test(value),
      "Enter a valid branch name, e.g. main or release/2.4",
    )
    .nullable(),
);

const repoFields = z.object({
  repoUrl: repoUrlSchema.optional().transform((value) => value ?? null),
  repoBranch: branchSchema.optional().transform((value) => value ?? null),
});

export const applicationInputSchema = z
  .object({
    projectId: z.cuid({ error: "Select a project" }),
    name: requiredText("Name", 120),
    authorizedUrl: authorizedUrlSchema,
    environment: z.enum(AppEnvironment, { error: "Select an environment" }),
    type: z.enum(AppType).default(AppType.WEB),
    description: optionalText("Description", 2000),
    ...repoFields.shape,
  })
  .refine((value) => !value.repoBranch || value.repoUrl, {
    message: "Add a repository URL to set a branch",
    path: ["repoBranch"],
    // Report this alongside other field errors, as long as the two repo fields are valid themselves.
    when: (payload) => repoFields.safeParse(payload.value).success,
  });

export type ApplicationInput = z.infer<typeof applicationInputSchema>;
