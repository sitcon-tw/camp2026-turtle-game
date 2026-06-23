import { Link, NavLink, Outlet, useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { LogOutIcon, TurtleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { studentApi } from "@/lib/student/api"
import { clearTeamToken } from "@/lib/student/session"

type StudentMe = {
  name?: string
  code?: string
  team?: {
    name?: string
    code?: string
  }
}

export default function StudentLayout() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useQuery({
    queryKey: ["student", "me"],
    queryFn: studentApi.me,
    retry: false,
  })

  const session = (me.data ?? {}) as StudentMe
  const teamLabel = session.team?.name ?? session.name ?? session.team?.code ?? session.code ?? "隊伍"

  function logout() {
    clearTeamToken()
    queryClient.removeQueries({ queryKey: ["student"] })
    navigate("/")
  }

  return (
    <main className="min-h-svh bg-[linear-gradient(180deg,hsl(var(--background)),hsl(var(--muted)))]">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/challenges" className="flex items-center gap-3 font-semibold">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <TurtleIcon className="size-5" />
            </span>
            <span>Turtle Challenge</span>
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            <Button variant="ghost" nativeButton={false} render={<NavLink to="/challenges" />}>
              挑戰列表
            </Button>
          </nav>
          <div className="flex items-center gap-3">
            <div className="hidden text-right text-sm sm:block">
              <p className="font-medium">{teamLabel}</p>
              <p className="text-xs text-muted-foreground">學生端</p>
            </div>
            <Button variant="outline" size="sm" onClick={logout}>
              <LogOutIcon /> 登出
            </Button>
          </div>
        </div>
      </header>
      <Separator />
      <Outlet />
    </main>
  )
}
