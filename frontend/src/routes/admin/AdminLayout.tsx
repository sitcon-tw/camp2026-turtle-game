import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom"
import {
  ArrowLeftIcon,
  Gamepad2Icon,
  ListChecksIcon,
  LogOutIcon,
  TurtleIcon,
  UsersIcon,
} from "lucide-react"

import { AdminFloatingTimer } from "@/components/admin/AdminFloatingTimer"
import { AdminHealthPill, LoadingState } from "@/components/admin/AdminPrimitives"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { useGameEvents } from "@/hooks/use-game-events"
import { adminApi } from "@/lib/admin/api"
import { clearAdminToken, getAdminToken } from "@/lib/admin/session"
import type { AdminMeResponse } from "@/lib/admin/types"
import type { AdminRouteContext } from "@/routes/admin/admin-route-context"

const navItems = [
  { href: "/admin", label: "指揮中心", icon: Gamepad2Icon },
  { href: "/admin/challenges", label: "挑戰題目", icon: ListChecksIcon },
  { href: "/admin/teams", label: "隊伍", icon: UsersIcon },
]

function isActivePath(pathname: string, href: string) {
  if (href === "/admin") return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function AdminLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [session, setSession] = useState<AdminMeResponse | null>(null)
  const [checking, setChecking] = useState(true)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const token = getAdminToken()
  const sessionReady = Boolean(token && session)

  const game = useQuery({
    queryKey: ["game", "state", "admin"],
    queryFn: adminApi.gameState,
    enabled: sessionReady,
    refetchInterval: 10_000,
  })

  const connectionState = useGameEvents({
    enabled: sessionReady,
    token,
    onSnapshot: (snapshot) => queryClient.setQueryData(["game", "state", "admin"], snapshot),
    onError: () => undefined,
  })

  useEffect(() => {
    let cancelled = false

    async function verifySession() {
      if (!token) {
        setChecking(false)
        return
      }

      try {
        const [me, health] = await Promise.allSettled([adminApi.me(), adminApi.health()])
        if (cancelled) return

        if (me.status === "fulfilled") setSession(me.value)
        if (health.status === "fulfilled") setHealthOk(health.value.ok)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }

    verifySession()

    return () => {
      cancelled = true
    }
  }, [token])

  const activeLabel = useMemo(() => {
    return navItems.find((item) => isActivePath(location.pathname, item.href))?.label ?? "管理後台"
  }, [location.pathname])

  const adminContext = useMemo<AdminRouteContext>(() => ({
    game,
    connectionState,
  }), [connectionState, game])

  function handleLogout() {
    clearAdminToken()
    navigate("/admin/login", { replace: true })
  }

  if (!token) {
    return <Navigate to="/admin/login" replace state={{ from: location }} />
  }

  if (checking) {
    return (
      <main className="min-h-svh bg-paper p-4 text-ink sm:p-8">
        <div className="mx-auto max-w-3xl">
          <LoadingState title="正在開啟管理後台" description="正在檢查管理員工作階段。" rows={4} />
        </div>
      </main>
    )
  }

  if (!session) {
    return <Navigate to="/admin/login" replace state={{ from: location }} />
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="繪圖挑戰賽管理後台" render={<Link to="/admin" />}>
                <span className="flex size-8 items-center justify-center rounded-[0.75rem] border-2 border-ink bg-primary text-primary-foreground shadow-[2px_2px_0_rgba(23,35,58,0.16)]">
                  <TurtleIcon className="size-4" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-medium">繪圖挑戰賽</span>
                  <span className="truncate text-xs text-muted-foreground">管理後台</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>操作</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      tooltip={item.label}
                      isActive={isActivePath(location.pathname, item.href)}
                      render={<Link to={item.href} />}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarSeparator />
        <SidebarFooter>
          <div className="flex items-center justify-between gap-2 px-2 group-data-[collapsible=icon]:justify-center">
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-sm font-medium">{session.subject}</p>
              <p className="text-xs text-muted-foreground">{session.role}</p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={handleLogout} aria-label="登出">
              <LogOutIcon />
            </Button>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b-2 border-ink bg-surface-raised/95 px-4 shadow-[0_3px_0_rgba(23,35,58,0.12)] backdrop-blur sm:px-6">
          <SidebarTrigger />
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-muted-foreground">管理後台</p>
              <h1 className="truncate text-lg font-semibold tracking-tight">{activeLabel}</h1>
            </div>
          </div>
          <AdminHealthPill ok={healthOk} />
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" />}>
            <ArrowLeftIcon /> 返回遊戲
          </Button>
        </header>
        <main className="flex-1 bg-paper p-4 sm:p-6">
          <Outlet context={adminContext} />
        </main>
        <AdminFloatingTimer snapshot={game.data} connectionState={connectionState} loading={game.isLoading} />
      </SidebarInset>
    </SidebarProvider>
  )
}
