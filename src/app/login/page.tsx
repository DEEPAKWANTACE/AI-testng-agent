import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/components/forms/action-form";
import { TextField } from "@/components/forms/fields";
import { login } from "@/modules/auth/actions";
import { getCurrentActor } from "@/modules/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-indigo-600 text-xs font-bold text-white">QA</span>
          <span className="text-base font-semibold">QA Agent</span>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="mb-1 text-lg font-semibold">Sign in</h1>
          <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">Use your QA Agent account.</p>
          <Suspense>
            <LoginForm searchParams={searchParams} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

async function LoginForm({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  if (await getCurrentActor()) redirect("/");
  const { next } = await searchParams;

  return (
    <ActionForm action={login} submitLabel="Sign in" pendingLabel="Signing in…">
      <input type="hidden" name="next" value={typeof next === "string" ? next : "/"} />
      <TextField name="email" label="Email" type="email" autoComplete="username" required />
      <TextField name="password" label="Password" type="password" autoComplete="current-password" required />
    </ActionForm>
  );
}
