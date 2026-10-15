"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { cn, type SelectOption } from "@/lib/utils";
import { useFieldState } from "./action-form";

const controlClasses =
  "block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs ring-1 ring-inset ring-zinc-300 " +
  "placeholder:text-zinc-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 focus:outline-none " +
  "dark:bg-zinc-950 dark:text-zinc-100 dark:ring-zinc-700";

type ControlProps = {
  "aria-invalid": boolean;
  "aria-describedby"?: string;
  className: string;
  defaultValue?: string | number | readonly string[];
};

function FieldShell({
  id,
  name,
  label,
  hint,
  defaultValue,
  children,
}: {
  id: string;
  name: string;
  label: string;
  hint?: ReactNode;
  defaultValue?: string | number | readonly string[];
  children: (props: ControlProps) => ReactNode;
}) {
  const { errors, submittedValue } = useFieldState(name);
  const hasError = Boolean(errors?.length);
  const describedBy = hasError ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
      </label>
      {children({
        "aria-invalid": hasError,
        "aria-describedby": describedBy,
        className: cn(controlClasses, hasError && "ring-red-400 dark:ring-red-700"),
        defaultValue: submittedValue ?? defaultValue,
      })}
      {hasError ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          {errors?.[0]}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type BaseProps = { name: string; label: string; hint?: ReactNode };

export function TextField({ name, label, hint, defaultValue, ...props }: BaseProps & Omit<ComponentProps<"input">, "name">) {
  const id = useId();
  return (
    <FieldShell id={id} name={name} label={label} hint={hint} defaultValue={defaultValue}>
      {(control) => <input id={id} name={name} type="text" {...props} {...control} />}
    </FieldShell>
  );
}

export function TextAreaField({
  name,
  label,
  hint,
  rows = 3,
  defaultValue,
  ...props
}: BaseProps & Omit<ComponentProps<"textarea">, "name">) {
  const id = useId();
  return (
    <FieldShell id={id} name={name} label={label} hint={hint} defaultValue={defaultValue}>
      {(control) => <textarea id={id} name={name} rows={rows} {...props} {...control} />}
    </FieldShell>
  );
}

export function SelectField({
  name,
  label,
  hint,
  options,
  placeholder,
  defaultValue,
  ...props
}: BaseProps & Omit<ComponentProps<"select">, "name"> & { options: SelectOption[]; placeholder?: string }) {
  const id = useId();
  // React doesn't apply a changed defaultValue to a mounted <select>, so the form reset after an
  // action would restore the original option. Remounting on the echoed value keeps the selection.
  const { submittedValue } = useFieldState(name);
  return (
    <FieldShell id={id} name={name} label={label} hint={hint} defaultValue={defaultValue}>
      {(control) => (
        <select key={submittedValue ?? ""} id={id} name={name} {...props} {...control}>
          {placeholder ? <option value="">{placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
