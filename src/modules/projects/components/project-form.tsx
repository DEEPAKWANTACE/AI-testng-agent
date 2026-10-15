import { ActionForm, type FormAction } from "@/components/forms/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/forms/fields";
import { ProjectStatus } from "@/generated/prisma/enums";
import { enumOptions } from "@/lib/utils";

type ProjectDefaults = { name: string; description: string | null; status: ProjectStatus };

export function ProjectForm({
  action,
  defaults,
  submitLabel,
}: {
  action: FormAction;
  defaults?: ProjectDefaults;
  submitLabel: string;
}) {
  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <TextField name="name" label="Name" placeholder="Customer portal" defaultValue={defaults?.name} required />
      <TextAreaField
        name="description"
        label="Description"
        placeholder="What this project covers"
        defaultValue={defaults?.description ?? ""}
      />
      {defaults ? (
        <SelectField name="status" label="Status" options={enumOptions(ProjectStatus)} defaultValue={defaults.status} />
      ) : null}
    </ActionForm>
  );
}
