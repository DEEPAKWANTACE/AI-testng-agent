import type { Prisma } from "@/generated/prisma/client";
import { DomainError } from "@/lib/action-state";
import { db } from "@/lib/db";
import { assertApplicationPermission } from "@/modules/access/service";
import { audit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/auth/service";
import { pageElementsSchema } from "@/modules/discovery/page-elements";
import { referencedSecrets, resolveNavigation } from "@/modules/execution/steps";
import { enqueueGeneration, QueueUnavailableError } from "@/modules/jobs/queues";
import { INVENTORY_FEATURE_NAMES, loadInventoryContext } from "./inventory-context";
import { buildPrompt, type GenerationContext } from "./prompt";
import { providerFromEnv, ProviderError, type GenerationProvider } from "./providers";
import { generatedCaseSchema, generationEnvelopeSchema, type GeneratedCase } from "./schema";

const MAX_FEATURES = 15;

/** Records a generation request and queues it. Output lands as PROPOSED cases in a draft suite. */
export async function requestGeneration(
  actor: Actor,
  input: { applicationId: string; featureIds: string[]; requirements: string | null; suiteId: string | null },
) {
  await assertApplicationPermission(actor, input.applicationId, "suite.edit");
  if (input.featureIds.length === 0) throw new DomainError("Select at least one feature.");
  if (input.featureIds.length > MAX_FEATURES) throw new DomainError(`Select at most ${MAX_FEATURES} features at a time.`);
  const owned = await db().feature.count({ where: { id: { in: input.featureIds }, applicationId: input.applicationId } });
  if (owned !== input.featureIds.length) throw new DomainError("Some selected features don't belong to this application.");
  if (input.suiteId) {
    const suite = await db().testSuite.findFirst({
      where: { id: input.suiteId, applicationId: input.applicationId, status: "ACTIVE" },
      select: { _count: { select: { planVersions: { where: { status: "PENDING_APPROVAL" } } } } },
    });
    if (!suite) throw new DomainError("Choose an active suite of this application.");
    if (suite._count.planVersions) throw new DomainError("That suite is awaiting review; generate into another suite.");
  }

  const app = await db().application.findUniqueOrThrow({ where: { id: input.applicationId }, select: { projectId: true } });
  const job = await db().generationJob.create({ data: { ...input, requestedById: actor.id }, select: { id: true } });
  await audit({ actor, action: "generation.requested", entityType: "GenerationJob", entityId: job.id, projectId: app.projectId, data: { featureIds: input.featureIds } });
  try {
    await enqueueGeneration(job.id);
  } catch (error) {
    const message = error instanceof QueueUnavailableError ? error.message : "Couldn't queue the generation job.";
    await db().generationJob.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: message, finishedAt: new Date() } });
    throw new DomainError(message);
  }
  return job;
}

async function loadContext(jobId: string): Promise<{ context: GenerationContext; job: { applicationId: string; suiteId: string | null; projectId: string; requestedById: string | null; features: Array<{ id: string; name: string }> } }> {
  const job = await db().generationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      applicationId: true,
      suiteId: true,
      requestedById: true,
      featureIds: true,
      requirements: true,
      application: {
        select: {
          name: true,
          projectId: true,
          authorizedUrl: true,
          environment: true,
          secrets: { select: { name: true } },
          discoveryAuth: { select: { mode: true, loginUrl: true, usernameSelector: true, usernameSecret: { select: { name: true } }, passwordSecret: { select: { name: true } } } },
        },
      },
    },
  });
  const features = await db().feature.findMany({
    where: { id: { in: job.featureIds }, applicationId: job.applicationId },
    select: { id: true, name: true, url: true, pages: { orderBy: { createdAt: "desc" }, take: 20, select: { url: true, title: true, elements: true, error: true } } },
  });
  const auth = job.application.discoveryAuth;
  const inventory = await loadInventoryContext(job.applicationId);
  return {
    job: { applicationId: job.applicationId, suiteId: job.suiteId, projectId: job.application.projectId, requestedById: job.requestedById, features: features.map((f) => ({ id: f.id, name: f.name })) },
    context: {
      application: { name: job.application.name, authorizedUrl: job.application.authorizedUrl, environment: job.application.environment },
      requirements: job.requirements,
      inventory,
      secretNames: job.application.secrets.map((s) => s.name),
      login:
        auth?.mode === "FORM_LOGIN" && auth.loginUrl && auth.usernameSecret && auth.passwordSecret
          ? {
              path: new URL(auth.loginUrl).pathname,
              usernameSelector: auth.usernameSelector || 'input[type="email"], input[autocomplete="username"]',
              usernameSecret: auth.usernameSecret.name,
              passwordSecret: auth.passwordSecret.name,
            }
          : null,
      features: features.map((f) => {
        // Latest crawl of each URL only.
        const seen = new Set<string>();
        const pages = f.pages.filter((p) => !p.error && !seen.has(p.url) && seen.add(p.url));
        return {
          name: f.name,
          url: f.url,
          pages: pages.slice(0, 5).flatMap((p) => {
            const elements = pageElementsSchema.safeParse(p.elements);
            return elements.success ? [{ url: p.url, title: p.title, elements: elements.data }] : [];
          }),
        };
      }),
    },
  };
}

/** Validates each generated case on its own; returns valid cases and how many were rejected. */
export function validateGeneratedCases(raw: unknown, context: GenerationContext): { cases: GeneratedCase[]; rejected: number } {
  const envelope = generationEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new ProviderError("The generator's output didn't match the expected format", false);
  // Inventory-derived cases may use the inventory pseudo-features (API contracts, Access control…).
  const featureNames = new Set([...context.features.map((f) => f.name), ...(context.inventory ? INVENTORY_FEATURE_NAMES : [])]);
  const secretNames = new Set(context.secretNames);
  const titles = new Set<string>();
  const cases: GeneratedCase[] = [];
  let rejected = 0;
  for (const candidate of envelope.data.cases) {
    const parsed = generatedCaseSchema.safeParse(candidate);
    const ok =
      parsed.success &&
      featureNames.has(parsed.data.feature) &&
      !titles.has(parsed.data.title.toLowerCase()) &&
      parsed.data.steps.every((s) => (s.kind !== "NAVIGATE" && s.kind !== "API_GET") || resolveNavigation(s.params.url, context.application.authorizedUrl)) &&
      referencedSecrets(parsed.data.steps.map((s) => ({ kind: s.kind, params: s.params }))).every((n) => secretNames.has(n));
    if (!ok) {
      rejected++;
      continue;
    }
    titles.add(parsed.data.title.toLowerCase());
    cases.push(parsed.data);
  }
  return { cases, rejected };
}

/** Worker side: runs the generator and saves PROPOSED cases. Retryable provider errors rethrow. */
export async function processGeneration(jobId: string, provider: GenerationProvider = providerFromEnv(), attempt = 1, maxAttempts = 3) {
  const claimed = await db().generationJob.updateMany({ where: { id: jobId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "RUNNING" } });
  if (claimed.count === 0) return;
  const { context, job } = await loadContext(jobId);
  const prompt = buildPrompt(context);
  const actor = job.requestedById ? await db().user.findUnique({ where: { id: job.requestedById }, select: { id: true, email: true } }) : null;

  try {
    const result = await provider.generate(prompt, context);
    const { cases, rejected } = validateGeneratedCases(result.raw, context);
    if (cases.length === 0) throw new ProviderError(`The generator produced no valid test cases (${rejected} rejected)`, false);

    const featureIds = new Map(job.features.map((f) => [f.name, f.id]));
    const suiteId = await db().$transaction(async (tx) => {
      const suite = job.suiteId
        ? { id: job.suiteId }
        : await tx.testSuite.create({
            data: {
              applicationId: job.applicationId,
              name: `Generated: ${job.features.map((f) => f.name).slice(0, 3).join(", ")}${job.features.length > 3 ? "…" : ""} (${new Date().toISOString().slice(0, 16).replace("T", " ")})`.slice(0, 160),
              description: context.requirements ? `Requirements: ${context.requirements.slice(0, 1000)}` : null,
              source: "AI_GENERATED",
              createdById: job.requestedById,
            },
            select: { id: true },
          });
      const last = await tx.testCase.aggregate({ where: { suiteId: suite.id }, _max: { position: true } });
      let position = (last._max.position ?? -1) + 1;
      for (const c of cases) {
        await tx.testCase.create({
          data: {
            suiteId: suite.id,
            featureId: featureIds.get(c.feature) ?? null,
            title: c.title,
            prerequisites: c.prerequisites,
            expectedResult: c.expectedResult,
            priority: c.priority,
            type: c.category,
            requirementRefs: c.coverage.requirements,
            description: c.coverage.notes ?? null,
            source: "AI_GENERATED",
            reviewState: "PROPOSED",
            generationJobId: jobId,
            position: position++,
            createdById: job.requestedById,
            steps: {
              create: c.steps.map((s, i) => ({
                position: i,
                action: s.description,
                expectedResult: s.expected ?? null,
                kind: s.kind,
                params: s.params as Prisma.InputJsonValue,
              })),
            },
          },
        });
      }
      await tx.generationJob.update({
        where: { id: jobId },
        data: {
          status: "SUCCEEDED",
          suiteId: suite.id,
          caseCount: cases.length,
          rejectedCount: rejected,
          provider: result.provider,
          model: result.model,
          promptHash: prompt.hash,
          usage: (result.usage ?? undefined) as Prisma.InputJsonValue | undefined,
          finishedAt: new Date(),
        },
      });
      return suite.id;
    }, { timeout: 30_000 });
    await audit({ actor, action: "generation.completed", entityType: "GenerationJob", entityId: jobId, projectId: job.projectId, data: { suiteId, cases: cases.length, rejected, provider: result.provider, model: result.model, promptHash: prompt.hash } });
  } catch (error) {
    const retryable = error instanceof ProviderError && error.retryable && attempt < maxAttempts;
    const message = error instanceof ProviderError ? error.message : "Generation failed unexpectedly. Check the worker logs.";
    if (!(error instanceof ProviderError)) console.error(`[generation] job ${jobId} failed`, error);
    if (retryable) {
      await db().generationJob.update({ where: { id: jobId }, data: { status: "QUEUED", errorMessage: `Attempt ${attempt}: ${message}` } });
      throw error;
    }
    await db().generationJob.update({ where: { id: jobId }, data: { status: "FAILED", errorMessage: message, promptHash: prompt.hash, finishedAt: new Date() } });
    await audit({ actor, action: "generation.failed", entityType: "GenerationJob", entityId: jobId, projectId: job.projectId, data: { error: message } });
  }
}

export async function getGenerationJobsForApplication(applicationId: string) {
  return db().generationJob.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" }, take: 10, include: { suite: { select: { id: true, name: true } } } });
}

