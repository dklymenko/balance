import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Suspense, useEffect } from "react";
import { Receipt, PieChart, Wallet, Settings, type LucideIcon } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import { useT } from "@/lib/i18n";

// Primary navigation, in daily-use order: Transactions is home; Accounts is
// visited rarely. Categories management lives inside Settings. (Balance has no
// Plans/Debt, so those design tabs are dropped.)
const ITEMS: { to: string; labelKey: string; icon: LucideIcon }[] = [
  { to: "/transactions", labelKey: "nav.transactions", icon: Receipt },
  { to: "/reports", labelKey: "nav.reports", icon: PieChart },
  { to: "/accounts", labelKey: "nav.accounts", icon: Wallet },
  { to: "/settings/household", labelKey: "nav.settings", icon: Settings },
];

// App shell: a horizontal top bar on desktop (≥md) and a bottom tab bar on
// mobile. Active tab is tinted with the brand coral (text-primary); inactive
// tabs recede.
// Per-route document title (browser tab / PWA), so open tabs and history are
// distinguishable instead of every screen reading "Balance".
const TITLE_KEYS: Record<string, string> = {
  "/transactions": "nav.transactions",
  "/reports": "nav.reports",
  "/accounts": "nav.accounts",
  "/categories": "settings.categories",
  "/settings/household": "nav.settings",
};

export default function NavShell() {
  const location = useLocation();
  const t = useT();
  useEffect(() => {
    const key = TITLE_KEYS[location.pathname];
    document.title = key ? `Balance -- ${t(key)}` : "Balance";
  }, [location.pathname, t]);

  return (
    <div className="min-h-screen">
      {/* Desktop top navigation bar. The bar spans full width (border) but its
          contents are constrained to the page column, with the tabs left-aligned
          directly above the content column and actions pushed right. */}
      <header className="sticky top-0 z-30 hidden h-14 items-center border-b border-border bg-background md:flex">
        <div className="mx-auto flex w-full max-w-6xl items-center px-4 sm:px-6">
          {/* Brand wordmark -- anchors the desktop bar (mobile uses the bottom tabs). */}
          <span className="mr-8 select-none text-lg font-bold tracking-tight text-primary">Balance</span>
          <nav aria-label="Primary" className="flex items-center gap-1 text-base">
            {ITEMS.map(({ to, labelKey, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  "flex items-center gap-2 rounded-lg px-3 py-1.5 transition-colors " +
                  (isActive ? "text-primary font-medium" : "text-muted-foreground hover:bg-secondary hover:text-foreground")
                }
              >
                <Icon className="h-4 w-4" />
                {t(labelKey)}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Page content. Pad for the top safe area, and (on mobile) the bottom bar. */}
      <main className="pt-[env(safe-area-inset-top)] pb-[calc(4.25rem+env(safe-area-inset-bottom))] md:pb-0">
        <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Loading…</div>}>
          <Outlet />
        </Suspense>
      </main>

      {/* Mobile bottom tab bar */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {ITEMS.map(({ to, labelKey, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors " +
              (isActive ? "text-primary" : "text-muted-foreground")
            }
          >
            <Icon className="h-5 w-5" />
            {t(labelKey)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
