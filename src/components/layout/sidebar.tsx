import Link from "next/link";
import { Suspense } from "react";
import { ActiveNavList, NavList } from "./nav-links";
import { UserMenu } from "./user-menu";

export function Sidebar() {
  return (
    <aside className="sticky top-0 z-10 flex flex-col border-b border-zinc-800 bg-zinc-950 lg:fixed lg:inset-y-0 lg:w-60 lg:border-r lg:border-b-0">
      <div className="flex h-14 items-center gap-2.5 px-5 lg:h-16">
        <span className="grid size-7 place-items-center rounded-md bg-indigo-600 text-xs font-bold text-white">QA</span>
        <Link href="/" className="text-sm font-semibold text-white">
          QA Agent
        </Link>
      </div>
      <nav aria-label="Main" className="overflow-x-auto px-3 pb-3 lg:flex-1 lg:pt-2">
        {/* usePathname suspends on dynamic routes, so keep the rest of the shell prerendered. */}
        <Suspense fallback={<NavList pathname={null} />}>
          <ActiveNavList />
        </Suspense>
      </nav>
      <div className="border-t border-zinc-800">
        <Suspense>
          <UserMenu />
        </Suspense>
      </div>
    </aside>
  );
}
