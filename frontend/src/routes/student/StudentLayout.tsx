import { Link, Outlet, useNavigate } from "react-router-dom"
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
    <main className="min-h-svh bg-paper text-ink">
      <header className="sticky top-0 z-30 border-b-2 border-ink bg-surface-raised/95 shadow-[0_3px_0_rgba(23,35,58,0.12)] backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/play" className="flex items-center gap-3 font-black">
            <span className="flex size-10 items-center justify-center rounded-[0.9rem] border-2 border-ink bg-primary text-primary-foreground shadow-[2px_2px_0_rgba(23,35,58,0.16)]">
              <TurtleIcon className="size-5" />
            </span>
            <span>繪圖挑戰賽</span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="hidden text-right text-sm sm:block">
              <p className="font-black">{teamLabel}</p>
              <p className="text-xs font-bold text-muted-foreground">Team Station</p>
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
