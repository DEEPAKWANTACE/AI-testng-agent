"use client";

import { ActionForm, type FormAction } from "@/components/forms/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/forms/fields";

export function InventoryDocumentForm({ action }: { action: FormAction }) {
  return (
    <ActionForm action={action} submitLabel="Analyse document" pendingLabel="Analysing…">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="source"
          label="Type"
          options={[
            { value: "OPENAPI", label: "OpenAPI / Swagger (JSON or YAML)" },
            { value: "REQUIREMENTS", label: "Requirements (text or Markdown)" },
          ]}
        />
        <TextField name="name" label="Name" placeholder="openapi.yaml, checkout-requirements.md" hint="Re-uploading the same name replaces what that document contributed." />
      </div>
      <TextAreaField name="content" label="Content" rows={10} placeholder={"REQ-1: Customers can apply one coupon per order.\n  - SPRING10 takes 10% off the subtotal"} />
    </ActionForm>
  );
}

export function SourceAnalysisForm({ action, secretNames }: { action: FormAction; secretNames: string[] }) {
  return (
    <ActionForm action={action} submitLabel="Analyse repository" pendingLabel="Queueing…">
      <SelectField
        name="tokenSecret"
        label="Access token (private repositories)"
        hint="A read-only token stored as an application secret reference. Public repositories need none."
        options={[{ value: "", label: "None (public repository)" }, ...secretNames.map((name) => ({ value: name, label: name }))]}
      />
    </ActionForm>
  );
}
