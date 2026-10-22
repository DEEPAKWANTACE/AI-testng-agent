import "server-only";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission } from "@/modules/access/service";
import { createApplication } from "@/modules/applications/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import { saveDiscoveryAuth } from "@/modules/discovery/auth-config";
import { upsertLocalSecret } from "@/modules/secrets/local";
import { isVaultConfigured } from "@/modules/secrets/vault";
import type { AutoTestInput } from "./schemas";

const USERNAME_SECRET = "AUTO_TEST_USERNAME";
const PASSWORD_SECRET = "AUTO_TEST_PASSWORD";
const MAX_DEPTH = 10;

/**
 * One-shot entry point: register the application (or reuse it), store the test account
 * encrypted, queue a discovery crawl and flag it to queue test-case generation for every
 * discovered feature when it completes. Generated cases are PROPOSED drafts — a person still
 * reviews, submits and approves each plan before anything runs.
 */
export async function startAutoTest(actor: Actor, input: AutoTestInput) {
  const hasCredentials = !!input.username && !!input.password;
  if (hasCredentials && !isVaultConfigured()) {
    throw new DomainError("Credential storage isn't configured: set SECRETS_ENCRYPTION_KEY on the server (openssl rand -base64 32), or use env:// secret references.");
  }

  const existing = await db().application.findFirst({
    where: { projectId: input.projectId, authorizedUrl: input.url },
    select: { id: true },
  });
  const applicationId =
    existing?.id ??
    (
      await createApplication(actor, {
        projectId: input.projectId,
        name: input.name ?? new URL(input.url).host,
        authorizedUrl: input.url,
        environment: input.environment,
        type: "WEB",
        description: "Created by Auto-test.",
        repoUrl: null,
        repoBranch: null,
      })
    ).id;
  await assertApplicationPermission(actor, applicationId, "discovery.run");

  if (hasCredentials) {
    await assertApplicationPermission(actor, applicationId, "secret.manage");
    const usernameSecretId = await upsertLocalSecret(actor, applicationId, USERNAME_SECRET, input.username!, "Entered in the Auto-test form (encrypted at rest).");
    const passwordSecretId = await upsertLocalSecret(actor, applicationId, PASSWORD_SECRET, input.password!, "Entered in the Auto-test form (encrypted at rest).");
    await saveDiscoveryAuth(actor, applicationId, {
      mode: "FORM_LOGIN",
      loginUrl: input.loginUrl ?? input.url,
      usernameSecretId,
      passwordSecretId,
    } as Parameters<typeof saveDiscoveryAuth>[2]);
  }

  const run = await db().discoveryRun.create({
    data: { applicationId, startUrl: input.url, maxDepth: MAX_DEPTH, maxPages: input.maxPages, autoGenerate: true, triggeredById: actor.id },
    select: { id: true },
  });
  await audit({
    actor,
    action: "autotest.started",
    entityType: "DiscoveryRun",
    entityId: run.id,
    projectId: input.projectId,
    data: { applicationId, url: input.url, signedIn: hasCredentials, maxPages: input.maxPages },
  });
  return { applicationId, runId: run.id };
}
