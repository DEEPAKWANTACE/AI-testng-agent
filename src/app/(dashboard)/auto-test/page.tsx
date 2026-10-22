import type { Metadata } from "next";
import { Suspense } from "react";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextField } from "@/components/forms/fields";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { AppEnvironment } from "@/generated/prisma/enums";
import { enumOptions } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { startAutoTestAction } from "@/modules/auto-test/actions";
import { listProjectsForNewApplications } from "@/modules/projects/service";
import { isVaultConfigured } from "@/modules/secrets/vault";

export const metadata: Metadata = { title: "Auto-test" };

export default function AutoTestPage() {
  return (
    <>
      <PageHeader
        title="Auto-test a whole application"
        description="Give a URL and (optionally) a test account. The agent signs in, crawls the app, and drafts test cases for every feature it finds."
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Suspense fallback={<CardSkeleton rows={8} />}>
            <AutoTestCard />
          </Suspense>
        </div>
        <Card>
          <CardHeader title="What happens next" />
          <CardBody>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
              <li>The application is registered and the account is stored encrypted.</li>
              <li>A crawler signs in and maps pages, forms and flows (up to the page limit).</li>
              <li>Test cases are drafted for each discovered feature, plus API and access-control cases when an inventory exists.</li>
              <li>Drafts wait for your review. Nothing runs until a person approves an immutable plan version.</li>
            </ol>
            <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
              Coverage is always &ldquo;of what was discovered&rdquo;: pages behind unreachable states, other roles, or beyond the page limit are not
              covered. Use a dedicated test account, never a real user&rsquo;s.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

async function AutoTestCard() {
  const actor = await requireActor();
  const projects = await listProjectsForNewApplications(actor);
  const vaultReady = isVaultConfigured();

  return (
    <Card>
      <CardHeader title="Application" />
      <CardBody>
        {projects.length === 0 ? (
          <EmptyState
            title="No projects you can add to"
            description="You need the Owner or Editor role on an active project."
            action={<LinkButton href="/projects">Go to projects</LinkButton>}
          />
        ) : (
          <ActionForm action={startAutoTestAction} submitLabel="Discover & generate tests" pendingLabel="Starting…">
            <SelectField name="projectId" label="Project" placeholder="Select a project" options={projects.map((p) => ({ value: p.id, label: p.name }))} defaultValue="" />
            <TextField name="url" label="Application URL" type="url" placeholder="https://staging.example.com" hint="The only origin the agent may test. Must be publicly reachable." />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="name" label="Name (optional)" placeholder="Defaults to the host name" />
              <SelectField name="environment" label="Environment" options={enumOptions(AppEnvironment)} defaultValue={AppEnvironment.STAGING} />
            </div>
            <fieldset className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <legend className="px-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Test account (optional)</legend>
              {vaultReady ? null : (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Credential storage isn&rsquo;t configured on this server. Set SECRETS_ENCRYPTION_KEY (openssl rand -base64 32) to enable it; without it only
                  signed-out pages can be tested.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField name="username" label="Username or email" autoComplete="off" disabled={!vaultReady} />
                <TextField name="password" label="Password" type="password" autoComplete="new-password" disabled={!vaultReady} hint="Encrypted at rest; never shown again or sent to the AI." />
              </div>
              <TextField name="loginUrl" label="Login page URL (optional)" type="url" placeholder="Defaults to the application URL" />
            </fieldset>
            <TextField name="maxPages" label="Max pages to crawl" type="number" min={1} max={200} defaultValue="60" />
            <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" name="authorized" className="mt-1" />
              <span>I&rsquo;m authorized to test this application with this account, and it doesn&rsquo;t hold real customer data I can&rsquo;t afford to change.</span>
            </label>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
