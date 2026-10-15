export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const dateFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const dateTimeFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function formatDate(date: Date | null | undefined): string {
  return date ? dateFormatter.format(date) : "—";
}

export function formatDateTime(date: Date | null | undefined): string {
  return date ? dateTimeFormatter.format(date) : "—";
}

/** Turns an enum value like `PENDING_APPROVAL` into `Pending approval`. */
export function humanize(value: string): string {
  const text = value.toLowerCase().replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export type SelectOption = { value: string; label: string };

/** Builds select options from a Prisma enum object, e.g. `enumOptions(AppType)`. */
export function enumOptions(values: Record<string, string>): SelectOption[] {
  return Object.values(values).map((value) => ({ value, label: humanize(value) }));
}
