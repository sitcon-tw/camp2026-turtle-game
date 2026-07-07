import { useEffect } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { adminApi } from "@/lib/admin/api"
import { getAdminToken } from "@/lib/admin/session"
import HomePage from "@/routes/HomePage"
import AdminLoginPage from "@/routes/admin/AdminLoginPage"
import AdminLayout from "@/routes/admin/AdminLayout"
import AdminCommandCenterPage from "@/routes/admin/AdminCommandCenterPage"
import AdminChallengesPage from "@/routes/admin/AdminChallengesPage"
import AdminTeamsPage from "@/routes/admin/AdminTeamsPage"
import BlackboardPage from "@/routes/BlackboardPage"
import { studentApi } from "@/lib/student/api"
import { getTeamToken } from "@/lib/student/session"
import StudentLayout from "@/routes/student/StudentLayout"
import TeamStationPage from "@/routes/student/TeamStationPage"
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

const APP_TITLE = "繪圖挑戰賽"

function DocumentTitle() {
  const { pathname } = useLocation()

  useEffect(() => {
    const routeTitles: Record<string, string> = {
      "/": "隊伍登入",
      "/play": "小隊工作站",
      "/blackboard": "黑板",
      "/admin/login": "管理員登入",
      "/admin": "管理中心",
      "/admin/challenges": "題目管理",
      "/admin/teams": "隊伍管理",
    }
    const routeTitle = routeTitles[pathname]
    document.title = routeTitle ? `${APP_TITLE} | ${routeTitle}` : APP_TITLE
  }, [pathname])

  return null
}

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
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      forcedTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <DocumentTitle />
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/blackboard" element={<BlackboardPage />} />
              <Route element={<RequireStudent />}>
                <Route element={<StudentLayout />}>
                  <Route path="/play" element={<TeamStationPage />} />
                </Route>
              </Route>
              <Route path="/admin/login" element={<AdminLoginPage />} />
              <Route element={<RequireAdmin />}>
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<AdminCommandCenterPage />} />
                  <Route path="challenges" element={<AdminChallengesPage />} />
                  <Route path="teams" element={<AdminTeamsPage />} />
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
