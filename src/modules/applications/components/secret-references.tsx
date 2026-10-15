import { ActionButton } from "@/components/forms/action-button";
import { ActionForm } from "@/components/forms/action-form";
import { TextField } from "@/components/forms/fields";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import type { SecretProvider } from "@/generated/prisma/enums";
import { humanize } from "@/lib/utils";
import type { SecretAvailability } from "@/modules/secrets/resolver";
import { addSecretReference, removeSecretReference } from "../actions";

type SecretRow = {
  id: string;
  name: string;
  provider: SecretProvider;
  reference: string | null;
  description: string | null;
  availability: SecretAvailability;
};

const availabilityTone = { available: "success", missing: "danger", external: "neutral" } as const;
const availabilityLabel = { available: "Resolvable", missing: "Not set", external: "External" } as const;

export function SecretReferences({
  applicationId,
  secrets,
  canManage,
}: {
  applicationId: string;
  secrets: SecretRow[];
  canManage: boolean;
}) {
  return (
    <Card>
      <CardHeader
        title="Secret references"
        description="Credentials the agent may use, stored as pointers to a secret manager — never as values."
      />
      {secrets.length === 0 ? (
        <EmptyState title="No secret references" />
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {secrets.map((secret) => (
            <li key={secret.id} className="flex items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100">
                  {secret.name}
                  <span className="font-sans font-normal text-zinc-500">{humanize(secret.provider)}</span>
                  <StatusBadge status={availabilityLabel[secret.availability]} tone={availabilityTone[secret.availability]} />
                </p>
                {secret.reference ? (
                  <p className="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{secret.reference}</p>
                ) : null}
                {secret.description ? <p className="mt-0.5 text-xs text-zinc-500">{secret.description}</p> : null}
              </div>
              {canManage ? (
                <ActionButton
                  action={removeSecretReference.bind(null, secret.id)}
                  variant="ghost"
                  confirmMessage={`Remove the ${secret.name} reference? The secret itself is not affected.`}
                >
                  Remove
                </ActionButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <CardBody className="border-t border-zinc-200 dark:border-zinc-800">
          <ActionForm action={addSecretReference.bind(null, applicationId)} submitLabel="Add reference" pendingLabel="Adding…">
            <TextField name="name" label="Name" placeholder="TEST_USER_PASSWORD" autoComplete="off" />
            <TextField
              name="reference"
              label="Reference"
              placeholder="env://QA_STOREFRONT_PASSWORD"
              autoComplete="off"
              spellCheck={false}
              hint="env://QA_…, vault://path#key, aws-sm://…, gcp-sm://projects/…, azure-kv://vault/name. Never paste the secret itself."
            />
            <TextField name="description" label="Description (optional)" autoComplete="off" />
          </ActionForm>
        </CardBody>
      ) : null}
    </Card>
  );
}
