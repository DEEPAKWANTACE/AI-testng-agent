import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionButton } from "@/components/forms/action-button";
import { ActionForm } from "@/components/forms/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/forms/fields";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CardSkeleton } from "@/components/ui/skeleton";
import { Priority, TestCaseType } from "@/generated/prisma/enums";
import { enumOptions } from "@/lib/utils";
import { requireActor } from "@/modules/auth/session";
import { archiveTestCase, updateTestCase } from "@/modules/test-suites/actions";
import { getTestCase } from "@/modules/test-suites/queries";

export default function EditCasePage({ params }: PageProps<"/test-plans/[suiteId]/cases/[caseId]">) {
  return (
    <Suspense fallback={<CardSkeleton rows={8} />}>
      <EditCase params={params} />
    </Suspense>
  );
}

async function EditCase({ params }: { params: PageProps<"/test-plans/[suiteId]/cases/[caseId]">["params"] }) {
  const actor = await requireActor();
  const { suiteId, caseId } = await params;
  const testCase = await getTestCase(actor, suiteId, caseId);
  if (!testCase) notFound();

  // Executable steps are edited as JSON (validated against the step language on save).
  const executable = testCase.steps.every((s) => s.kind !== null);
  const steps = executable
    ? JSON.stringify(
        testCase.steps.map((s) => ({ kind: s.kind, description: s.action, ...(s.expectedResult ? { expected: s.expectedResult } : {}), params: s.params })),
        null,
        2,
      )
    : testCase.steps.map((s) => s.action).join("\n");

  return (
    <>
      <PageHeader
        backHref={`/test-plans/${suiteId}`}
        backLabel={testCase.suite.name}
        title={`Edit: ${testCase.title}`}
        description="Saving changes the draft; a new version must be submitted and approved before the change can run."
        actions={
          <ActionButton action={archiveTestCase.bind(null, testCase.id)} variant="danger" confirmMessage="Remove this case from the suite? Past results are kept.">
            Remove case
          </ActionButton>
        }
      />
      <Card className="max-w-3xl">
        <CardHeader title="Case" />
        <CardBody>
          <ActionForm action={updateTestCase.bind(null, testCase.id)} submitLabel="Save case">
            <TextField name="title" label="Title" defaultValue={testCase.title} />
            <TextAreaField
              name="steps"
              label={executable ? "Steps (JSON)" : "Steps (one per line)"}
              rows={executable ? 18 : 6}
              defaultValue={steps}
              spellCheck={false}
              className="font-mono text-xs"
              hint="Allowed actions: NAVIGATE, CLICK, FILL, SELECT, WAIT, ASSERT. Locators: role, label, text, placeholder, testId or plain CSS. Fill secrets with {&quot;secret&quot;: &quot;NAME&quot;}."
            />
            <TextAreaField name="expectedResult" label="Expected result" rows={2} defaultValue={testCase.expectedResult ?? ""} />
            <TextAreaField name="prerequisites" label="Prerequisites (one per line)" rows={3} defaultValue={testCase.prerequisites.join("\n")} />
            <TextAreaField name="requirementRefs" label="Requirements covered (one per line)" rows={3} defaultValue={testCase.requirementRefs.join("\n")} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField name="priority" label="Priority" options={enumOptions(Priority)} defaultValue={testCase.priority} />
              <SelectField name="type" label="Category" options={enumOptions(TestCaseType)} defaultValue={testCase.type} />
            </div>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}
