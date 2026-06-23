import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { adminApi } from "@/lib/admin/api"
import { getAdminToken } from "@/lib/admin/session"
import HomePage from "@/routes/HomePage"
import AdminLoginPage from "@/routes/admin/AdminLoginPage"
import AdminLayout from "@/routes/admin/AdminLayout"
import AdminOverviewPage from "@/routes/admin/AdminOverviewPage"
import AdminTeamsPage from "@/routes/admin/AdminTeamsPage"
import AdminChallengeSetsPage from "@/routes/admin/AdminChallengeSetsPage"
import AdminChallengesPage from "@/routes/admin/AdminChallengesPage"
import AdminSubmissionsPage from "@/routes/admin/AdminSubmissionsPage"
import AdminJudgeQueuePage from "@/routes/admin/AdminJudgeQueuePage"
import AdminScoresPage from "@/routes/admin/AdminScoresPage"
import AdminSystemPage from "@/routes/admin/AdminSystemPage"
import BlackboardPage from "@/routes/BlackboardPage"
import { studentApi } from "@/lib/student/api"
import { getTeamToken } from "@/lib/student/session"
import StudentLayout from "@/routes/student/StudentLayout"
import ChallengeListPage from "@/routes/student/ChallengeListPage"
import ChallengePlayPage from "@/routes/student/ChallengePlayPage"
import "./App.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

function RequireAdmin() {
  const token = getAdminToken()
  const session = useQuery({
    queryKey: ["admin", "me"],
    queryFn: adminApi.me,
    enabled: Boolean(token),
    retry: false,
  })

  if (!token) return <Navigate to="/admin/login" replace />
  if (session.isError) return <Navigate to="/admin/login" replace />

  return <Outlet />
}

function RequireStudent() {
  const token = getTeamToken()
  const session = useQuery({
    queryKey: ["student", "me"],
    queryFn: studentApi.me,
    enabled: Boolean(token),
    retry: false,
  })

  if (!token) return <Navigate to="/" replace />
  if (session.isError) return <Navigate to="/" replace />

  return <Outlet />
}

function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/blackboard" element={<BlackboardPage />} />
              <Route element={<RequireStudent />}>
                <Route element={<StudentLayout />}>
                  <Route path="/challenges" element={<ChallengeListPage />} />
                  <Route path="/challenges/:challengeId" element={<ChallengePlayPage />} />
                </Route>
              </Route>
              <Route path="/admin/login" element={<AdminLoginPage />} />
              <Route element={<RequireAdmin />}>
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<AdminOverviewPage />} />
                  <Route path="teams" element={<AdminTeamsPage />} />
                  <Route path="challenge-sets" element={<AdminChallengeSetsPage />} />
                  <Route path="challenges" element={<AdminChallengesPage />} />
                  <Route path="submissions" element={<AdminSubmissionsPage />} />
                  <Route path="judge-queue" element={<AdminJudgeQueuePage />} />
                  <Route path="scores" element={<AdminScoresPage />} />
                  <Route path="system" element={<AdminSystemPage />} />
                </Route>
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App
