import { Sidebar } from "@/components/layout/sidebar";

export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="min-h-full">
      <Sidebar />
      <main className="lg:pl-60">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
