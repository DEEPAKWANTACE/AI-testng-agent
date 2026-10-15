import { LinkButton } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="text-center">
        <p className="text-sm font-semibold text-indigo-600">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Not found</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This record doesn&apos;t exist or has been deleted.</p>
        <LinkButton href="/" className="mt-6">
          Back to overview
        </LinkButton>
      </div>
    </div>
  );
}
