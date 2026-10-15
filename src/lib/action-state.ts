import { z } from "zod";

export type ActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  /** Submitted values, echoed back so fields keep their input after React resets the form. */
  values?: Record<string, string>;
};

export const initialActionState: ActionState = { status: "idle" };

export function validationError(error: z.ZodError, values?: Record<string, string>): ActionState {
  return {
    status: "error",
    message: "Please fix the highlighted fields.",
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[] | undefined>,
    values,
  };
}

export function failure(message: string, values?: Record<string, string>): ActionState {
  return { status: "error", message, values };
}

export function success(message: string): ActionState {
  return { status: "success", message };
}

/** Thrown by domain logic for expected, user-facing failures (e.g. invalid workflow transitions). */
export class DomainError extends Error {}

/** Maps unexpected errors to a safe message while preserving domain errors. */
export function toActionError(error: unknown, values?: Record<string, string>): ActionState {
  if (error instanceof DomainError) return failure(error.message, values);
  // Prisma unique-constraint violation (duck-typed so this module stays client-safe).
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
    return failure("That conflicts with an existing record (for example, a duplicate name). Refresh and try again.", values);
  }
  console.error(error);
  return failure("Something went wrong. Check the server logs for details.", values);
}
