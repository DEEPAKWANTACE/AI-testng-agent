import { ActionForm, type FormAction } from "@/components/forms/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/forms/fields";
import { AppEnvironment, AppType } from "@/generated/prisma/enums";
import { enumOptions } from "@/lib/utils";

type ApplicationDefaults = {
  projectId?: string;
  name?: string;
  authorizedUrl?: string;
  type?: AppType;
  environment?: AppEnvironment;
  description?: string | null;
  repoUrl?: string | null;
  repoBranch?: string | null;
};

export function ApplicationForm({
  action,
  projects,
  defaults,
  submitLabel,
}: {
  action: FormAction;
  projects: Array<{ id: string; name: string }>;
  defaults?: ApplicationDefaults;
  submitLabel: string;
}) {
  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <SelectField
        name="projectId"
        label="Project"
        placeholder="Select a project"
        options={projects.map((project) => ({ value: project.id, label: project.name }))}
        defaultValue={defaults?.projectId ?? ""}
      />
      <TextField name="name" label="Name" placeholder="Storefront" defaultValue={defaults?.name} />
      <TextField
        name="authorizedUrl"
        label="Authorized URL"
        type="url"
        placeholder="https://staging.example.com"
        defaultValue={defaults?.authorizedUrl}
        hint="The only origin the agent may test. Don't include credentials."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="environment"
          label="Environment"
          options={enumOptions(AppEnvironment)}
          defaultValue={defaults?.environment ?? AppEnvironment.STAGING}
        />
        <SelectField name="type" label="Type" options={enumOptions(AppType)} defaultValue={defaults?.type ?? AppType.WEB} />
      </div>
      <TextField
        name="repoUrl"
        label="Git repository (optional)"
        placeholder="https://github.com/acme/storefront"
        defaultValue={defaults?.repoUrl ?? ""}
        hint="https or ssh. Never include tokens — add them as secret references."
      />
      <TextField
        name="repoBranch"
        label="Branch (optional)"
        placeholder="main"
        defaultValue={defaults?.repoBranch ?? ""}
        hint="Leave empty to use the repository's default branch."
      />
      <TextAreaField name="description" label="Description" defaultValue={defaults?.description ?? ""} />
    </ActionForm>
  );
}
