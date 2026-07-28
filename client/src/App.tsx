import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { ThemeProvider } from './hooks/useTheme';
import { ToastProvider } from './hooks/useToast';
import { CalendarPage } from './pages/CalendarPage';
import { CrmPage } from './pages/CrmPage';
import { DashboardPage } from './pages/DashboardPage';
import { EbayResearchPage } from './pages/EbayResearchPage';
import { LeadsPage } from './pages/LeadsPage';
import { NotesPage } from './pages/NotesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ReferralPartnersPage } from './pages/ReferralPartnersPage';
import { SettingsPage } from './pages/SettingsPage';

function NotFoundPage() {
  return (
    <div className="card flex flex-col items-center px-6 py-16 text-center">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Page not found
      </h2>
      <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
        That page is not part of Wheelhouse.
      </p>
      <Link to="/" className="btn btn-primary mt-5">
        Back to dashboard
      </Link>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<DashboardPage />} />
              <Route path="leads" element={<LeadsPage />} />
              <Route path="crm" element={<CrmPage />} />
              <Route path="ebay" element={<EbayResearchPage />} />
              <Route path="referral-partners" element={<ReferralPartnersPage />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="calendar" element={<CalendarPage />} />
              <Route path="notes" element={<NotesPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  );
}
