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
import { normalizeLoginCodeInput } from "@/lib/login-code"
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
      navigate("/play")
    },
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    login.mutate(normalizeLoginCodeInput(teamCode).trim())
  }

  return (
    <main className="min-h-svh bg-background p-6">
      <div className="mx-auto flex min-h-[calc(100svh-3rem)] max-w-6xl items-center">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <section className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-sm text-muted-foreground backdrop-blur">
              <TurtleIcon className="size-4" />
              Turtle Game
            </div>
            <div className="space-y-4">
              <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">即時繪圖、投票與回合結果。</h1>
              <p className="max-w-2xl text-lg text-muted-foreground">輸入隊伍登入碼後，直接進入本隊的 Team Station。</p>
            </div>
            <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
              <div className="rounded-md border bg-card p-4">
                <UsersIcon className="mb-3 size-5 text-foreground" />
                以隊伍身分登入
              </div>
              <div className="rounded-md border bg-card p-4">
                <TurtleIcon className="mb-3 size-5 text-foreground" />
                完成本回合作品
              </div>
              <div className="rounded-md border bg-card p-4">
                <ArrowRightIcon className="mb-3 size-5 text-foreground" />
                參與隊內與公開投票
              </div>
            </div>
          </section>
          <Card>
            <CardHeader>
              <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <LockKeyholeIcon className="size-5" />
              </div>
              <CardTitle>隊伍登入</CardTitle>
              <CardDescription>請使用工作人員提供的隊伍登入碼進入小隊工作站。</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={handleSubmit}>
                <div className="grid gap-2">
                  <Label htmlFor="team-code">隊伍登入碼</Label>
                  <Input
                    id="team-code"
                    value={teamCode}
                    onChange={(event) => setTeamCode(normalizeLoginCodeInput(event.target.value))}
                    placeholder="輸入隊伍登入碼"
                    autoComplete="username"
                    autoCapitalize="characters"
                  />
                </div>
                {login.isError ? <p className="text-sm text-destructive">{studentErrorMessage(login.error)}</p> : null}
                <Button type="submit" size="lg" disabled={!teamCode.trim() || login.isPending}>
                  {login.isPending ? "登入中..." : "進入工作站"} <ArrowRightIcon />
                </Button>
              </form>
              <Separator className="my-5" />
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <ShieldIcon className="size-4" />
                  管理者入口
                </span>
                <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/admin/login" />}>
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
