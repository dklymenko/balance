import { Routes, Route, Navigate } from "react-router-dom";
import { lazy } from "react";
import NavShell from "@/components/NavShell";

// Route-level code splitting: the heavy pages (Reports pulls in recharts,
// Categories pulls in cmdk) load on demand, keeping the initial bundle small.
// The NavShell renders a <Suspense> boundary around the outlet.
const Transactions = lazy(() => import("@/pages/Transactions"));
const Reports = lazy(() => import("@/pages/Reports"));
const Accounts = lazy(() => import("@/pages/Accounts"));
const Categories = lazy(() => import("@/pages/Categories"));
const Household = lazy(() => import("@/pages/Household"));

function App() {
  return (
    <Routes>
      <Route element={<NavShell />}>
        <Route index element={<Navigate to="/transactions" replace />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/settings/household" element={<Household />} />
        <Route path="*" element={<Navigate to="/transactions" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
