import Link from "next/link";
import { redirect } from "next/navigation";
import { getRequestContext } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { getSectionData } from "@/core/reporting/sections";
import { NAV_ITEMS } from "@/lib/nav";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ section: string }> };

export default async function SectionPage({ params }: Params) {
  const { section } = await params;
  const context = await getRequestContext();
  if (!context) redirect("/login");
  if (!NAV_ITEMS.some((item) => item.slug === section)) redirect("/dashboard");

  const data = await getSectionData(getDb(), context.workspaceId, section);

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">SEARCHRANK OS</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{data.title}</h1>
        <p className="mt-2 text-sm text-slate-400">{data.subtitle}</p>
      </section>

      {(section === "github" || section === "vercel") && (
        <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h2 className="text-sm font-semibold">OAuth connection</h2>
            <p className="mt-1 text-xs text-slate-500">Least-privilege scopes. Tokens are encrypted at rest; private repositories are never imported.</p>
          </div>
          <a className="btn btn-primary" href={`/api/integrations/${section}/start`}>Connect {section === "github" ? "GitHub" : "Vercel"}</a>
        </div>
      )}

      <div className="card overflow-hidden">
        {data.rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-300">No records yet</p>
            <p className="mx-auto mt-2 max-w-md text-xs text-slate-500">
              This view shows only data that has actually been persisted. Connect an integration or
              enqueue a job from the overview to populate it.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-ink-900/60 text-slate-400">
                <tr>
                  {data.columns.map((column) => <th key={column} className="whitespace-nowrap px-5 py-3 font-semibold">{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, index) => (
                  <tr key={index} className="table-row border-t border-slate-700/30 align-top">
                    {data.columns.map((column) => (
                      <td key={column} className="max-w-md px-5 py-3 text-slate-300">{row[column] ?? "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.notes.length > 0 && (
        <div className="card p-5">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">System notes</h2>
          <ul className="list-inside list-disc space-y-1 text-xs text-slate-400">
            {data.notes.filter(Boolean).map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      )}

      <Link href="/dashboard" className="inline-block text-xs text-brand-400 hover:underline">← Back to overview</Link>
    </div>
  );
}
