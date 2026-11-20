import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/core/auth/request";
import { NAV_GROUPS, NAV_ITEMS } from "@/lib/nav";
import { LogoutButton } from "@/components/LogoutButton";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const context = await getRequestContext();
  if (!context) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-slate-700/40 bg-ink-900/70 px-4 py-6 lg:block">
        <Link href="/dashboard" className="mb-8 flex items-center gap-3 px-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 font-black text-ink-950">SR</span>
          <span>
            <span className="block text-sm font-bold tracking-wide">SEARCHRANK</span>
            <span className="block text-[10px] uppercase tracking-[0.2em] text-brand-400">OS</span>
          </span>
        </Link>
        <nav className="space-y-6">
          {NAV_GROUPS.map((group) => (
            <div key={group}>
              <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{group}</p>
              <ul className="space-y-0.5">
                {NAV_ITEMS.filter((item) => item.group === group).map((item) => {
                  const href = item.slug ? `/dashboard/${item.slug}` : "/dashboard";
                  return (
                    <li key={item.slug || "overview"}>
                      <Link
                        href={href}
                        className="block rounded-lg px-2.5 py-1.5 text-[13px] text-slate-400 transition hover:bg-slate-700/30 hover:text-slate-100"
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 border-b border-slate-700/40 bg-ink-950/85 px-5 py-3 backdrop-blur md:px-8">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Operations Console</p>
              <p className="truncate text-xs text-slate-500">{context.user.email} · {context.role}</p>
            </div>
            <LogoutButton />
          </div>
        </header>
        <main className="mx-auto max-w-[1500px] px-5 py-8 md:px-8">{children}</main>
      </div>
    </div>
  );
}
