import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextField } from "@/components/forms/fields";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { updateDiscoveryAuth } from "@/modules/discovery/actions";

type AuthConfig = {
  mode: "NONE" | "FORM_LOGIN";
  loginUrl: string | null;
  usernameSecretId: string | null;
  passwordSecretId: string | null;
  usernameSelector: string | null;
  passwordSelector: string | null;
  submitSelector: string | null;
  successSelector: string | null;
} | null;

/** Lets editors tell the discovery worker how to sign in, using secret references only. */
export function DiscoveryAuthCard({
  applicationId,
  authorizedUrl,
  config,
  secrets,
  canManage,
}: {
  applicationId: string;
  authorizedUrl: string;
  config: AuthConfig;
  secrets: Array<{ id: string; name: string }>;
  canManage: boolean;
}) {
  const mode = config?.mode ?? "NONE";
  if (!canManage) {
    return (
      <Card>
        <CardHeader title="Discovery login" />
        <CardBody className="text-sm text-zinc-600 dark:text-zinc-400">
          {mode === "FORM_LOGIN" ? `Signs in at ${config?.loginUrl} before crawling.` : "Discovery crawls without signing in."}
        </CardBody>
      </Card>
    );
  }

  const secretOptions = secrets.map((secret) => ({ value: secret.id, label: secret.name }));
  return (
    <Card>
      <CardHeader title="Discovery login" description="How the worker signs in before crawling. Credentials come from secret references." />
      <CardBody>
        <ActionForm action={updateDiscoveryAuth.bind(null, applicationId)} submitLabel="Save login settings">
          <SelectField
            name="mode"
            label="Sign-in"
            options={[
              { value: "NONE", label: "None — crawl public pages only" },
              { value: "FORM_LOGIN", label: "Form login" },
            ]}
            defaultValue={mode}
          />
          <TextField
            name="loginUrl"
            label="Login page URL"
            type="url"
            placeholder={`${authorizedUrl}/login`}
            defaultValue={config?.loginUrl ?? ""}
            hint="Must be within the authorized URL."
          />
          {secretOptions.length === 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">Add secret references for the username and password first.</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField name="usernameSecretId" label="Username secret" placeholder="Select…" options={secretOptions} defaultValue={config?.usernameSecretId ?? ""} />
            <SelectField name="passwordSecretId" label="Password secret" placeholder="Select…" options={secretOptions} defaultValue={config?.passwordSecretId ?? ""} />
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Advanced: CSS selectors (optional)</summary>
            <div className="mt-3 space-y-3">
              <TextField name="usernameSelector" label="Username field" placeholder="#email" defaultValue={config?.usernameSelector ?? ""} />
              <TextField name="passwordSelector" label="Password field" placeholder='input[type="password"]' defaultValue={config?.passwordSelector ?? ""} />
              <TextField name="submitSelector" label="Submit button" placeholder='form.login button[type="submit"]' defaultValue={config?.submitSelector ?? ""} />
              <TextField
                name="successSelector"
                label="Signed-in indicator"
                placeholder="#account-menu"
                defaultValue={config?.successSelector ?? ""}
                hint="An element that only appears when signed in. Needed for single-page apps that don't change URL."
              />
            </div>
          </details>
        </ActionForm>
      </CardBody>
    </Card>
  );
}
