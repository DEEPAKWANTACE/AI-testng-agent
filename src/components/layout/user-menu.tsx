import { humanize } from "@/lib/utils";
import { logout } from "@/modules/auth/actions";
import { requireActor } from "@/modules/auth/session";

/** Signed-in user and sign-out; reads the session, so it renders behind a Suspense boundary. */
export async function UserMenu() {
  const actor = await requireActor();
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-white">{actor.name}</p>
        <p className="truncate text-xs text-zinc-400">{humanize(actor.role)}</p>
      </div>
      <form action={logout}>
        <button type="submit" className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white">
          Sign out
        </button>
      </form>
    </div>
  );
}
