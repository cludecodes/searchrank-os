export interface NavItem {
  label: string;
  slug: string;
  group: "Overview" | "Intelligence" | "Operations" | "Administration";
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Executive Overview", slug: "", group: "Overview" },
  { label: "Projects Portfolio", slug: "projects", group: "Overview" },
  { label: "GitHub Connections", slug: "github", group: "Overview" },
  { label: "Vercel Connections", slug: "vercel", group: "Overview" },
  { label: "Discovery", slug: "discovery", group: "Overview" },
  { label: "SEO Audits", slug: "audits", group: "Intelligence" },
  { label: "Keyword Intelligence", slug: "keywords", group: "Intelligence" },
  { label: "Competitor Research", slug: "competitors", group: "Intelligence" },
  { label: "Content Studio", slug: "content", group: "Intelligence" },
  { label: "Backlink Opportunities", slug: "backlinks", group: "Intelligence" },
  { label: "Indexing Monitor", slug: "indexing", group: "Intelligence" },
  { label: "Google Search Console", slug: "google", group: "Intelligence" },
  { label: "Bing Webmaster", slug: "bing", group: "Intelligence" },
  { label: "AI Agents Control", slug: "agents", group: "Operations" },
  { label: "Automation Scheduler", slug: "scheduler", group: "Operations" },
  { label: "Analytics", slug: "analytics", group: "Operations" },
  { label: "Reports", slug: "reports", group: "Operations" },
  { label: "Security & Permissions", slug: "security", group: "Administration" },
  { label: "Business Growth", slug: "growth", group: "Operations" },
  { label: "Settings", slug: "settings", group: "Administration" },
];

export const NAV_GROUPS = ["Overview", "Intelligence", "Operations", "Administration"] as const;
