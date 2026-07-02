import { useEffect, useMemo, useState } from "react"
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom"
import {
  ArrowLeftIcon,
  Gamepad2Icon,
  ListChecksIcon,
  LogOutIcon,
  TurtleIcon,
  UsersIcon,
} from "lucide-react"

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
import { adminApi } from "@/lib/admin/api"
import { clearAdminToken, getAdminToken } from "@/lib/admin/session"
import type { AdminMeResponse } from "@/lib/admin/types"

const navItems = [
  { href: "/admin", label: "Command Center", icon: Gamepad2Icon },
  { href: "/admin/challenges", label: "Challenges", icon: ListChecksIcon },
  { href: "/admin/teams", label: "Teams", icon: UsersIcon },
]

function isActivePath(pathname: string, href: string) {
  if (href === "/admin") return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function AdminLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [session, setSession] = useState<AdminMeResponse | null>(null)
  const [checking, setChecking] = useState(true)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const token = getAdminToken()

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
    return navItems.find((item) => isActivePath(location.pathname, item.href))?.label ?? "Admin"
  }, [location.pathname])

  function handleLogout() {
    clearAdminToken()
    navigate("/admin/login", { replace: true })
  }

  if (!token) {
    return <Navigate to="/admin/login" replace state={{ from: location }} />
  }

  if (checking) {
    return (
      <main className="min-h-svh bg-muted/30 p-4 sm:p-8">
        <div className="mx-auto max-w-3xl">
          <LoadingState title="Opening admin" description="Checking your admin session." rows={4} />
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
              <SidebarMenuButton size="lg" tooltip="Turtle admin" render={<Link to="/admin" />}>
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <TurtleIcon className="size-4" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-medium">Turtle Game</span>
                  <span className="truncate text-xs text-muted-foreground">Admin Console</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Operations</SidebarGroupLabel>
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
            <Button variant="ghost" size="icon-sm" onClick={handleLogout} aria-label="Log out">
              <LogOutIcon />
            </Button>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur sm:px-6">
          <SidebarTrigger />
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-muted-foreground">Admin</p>
              <h1 className="truncate text-lg font-semibold tracking-tight">{activeLabel}</h1>
            </div>
          </div>
          <AdminHealthPill ok={healthOk} />
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" />}>
            <ArrowLeftIcon /> Home
          </Button>
        </header>
        <main className="flex-1 bg-muted/20 p-4 sm:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
