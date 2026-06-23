import { useState } from "react"
import type { FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowRightIcon, LockKeyholeIcon, ShieldIcon, TurtleIcon, UsersIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { studentApi, studentErrorMessage } from "@/lib/student/api"
import { setTeamToken } from "@/lib/student/session"

export default function HomePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [teamCode, setTeamCode] = useState("")

  const login = useMutation({
    mutationFn: studentApi.login,
    onSuccess: (session) => {
      setTeamToken(session.access_token)
      queryClient.invalidateQueries({ queryKey: ["student"] })
      navigate("/challenges")
    },
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    login.mutate(teamCode.trim())
  }

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_20%_18%,hsl(var(--muted)),transparent_30rem),radial-gradient(circle_at_80%_75%,hsl(var(--secondary)),transparent_26rem),linear-gradient(160deg,hsl(var(--background)),hsl(var(--muted)))] p-6">
      <div className="mx-auto flex min-h-[calc(100svh-3rem)] max-w-6xl items-center">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <section className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-sm text-muted-foreground backdrop-blur">
              <TurtleIcon className="size-4" />
              Turtle 繪圖挑戰
            </div>
            <div className="space-y-4">
              <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">查看挑戰狀態，追蹤隊伍評分進度。</h1>
              <p className="max-w-2xl text-lg text-muted-foreground">輸入隊伍登入碼後，就可以查看目前開放的挑戰、送出紀錄與評分佇列。</p>
            </div>
            <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
              <div className="rounded-2xl border bg-background/60 p-4 backdrop-blur">
                <UsersIcon className="mb-3 size-5 text-foreground" />
                以隊伍身分登入
              </div>
              <div className="rounded-2xl border bg-background/60 p-4 backdrop-blur">
                <TurtleIcon className="mb-3 size-5 text-foreground" />
                查看開放題目
              </div>
              <div className="rounded-2xl border bg-background/60 p-4 backdrop-blur">
                <ArrowRightIcon className="mb-3 size-5 text-foreground" />
                送出後等待評分
              </div>
            </div>
          </section>
          <Card className="bg-background/75 backdrop-blur">
            <CardHeader>
              <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <LockKeyholeIcon className="size-5" />
              </div>
              <CardTitle>隊伍登入</CardTitle>
              <CardDescription>請使用工作人員提供的隊伍登入碼進入挑戰頁面。</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={handleSubmit}>
                <div className="grid gap-2">
                  <Label htmlFor="team-code">隊伍登入碼</Label>
                  <Input id="team-code" value={teamCode} onChange={(event) => setTeamCode(event.target.value)} placeholder="輸入隊伍登入碼" autoComplete="username" />
                </div>
                {login.isError ? <p className="text-sm text-destructive">{studentErrorMessage(login.error)}</p> : null}
                <Button type="submit" size="lg" disabled={!teamCode.trim() || login.isPending}>
                  {login.isPending ? "登入中..." : "進入挑戰"} <ArrowRightIcon />
                </Button>
              </form>
              <Separator className="my-5" />
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <ShieldIcon className="size-4" />
                  管理者入口
                </span>
                <Button variant="outline" size="sm" render={<Link to="/admin/login" />}>
                  Admin
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
