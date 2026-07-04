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
    <main className="min-h-svh bg-paper p-4 text-ink sm:p-6">
      <div className="mx-auto flex min-h-[calc(100svh-2rem)] max-w-6xl items-center sm:min-h-[calc(100svh-3rem)]">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <section className="rounded-[1.75rem] border-2 border-ink bg-card p-5 shadow-[5px_5px_0_rgba(23,35,58,0.12)] sm:p-7">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border-2 border-ink bg-surface-raised px-3 py-1 text-sm font-black text-ink shadow-[2px_2px_0_rgba(23,35,58,0.14)]">
              <TurtleIcon className="size-4" />
              Turtle Game
            </div>
            <div className="flex flex-col gap-4">
              <h1 className="max-w-3xl text-4xl leading-[1.05] font-black tracking-normal sm:text-6xl">即時繪圖、投票與回合結果。</h1>
              <p className="max-w-2xl text-lg font-semibold text-muted-foreground">輸入隊伍登入碼後，直接進入本隊的 Team Station。</p>
            </div>
            <div className="mt-6 grid gap-3 text-sm font-black text-muted-foreground sm:grid-cols-3">
              <div className="rounded-[1rem] border-2 border-ink bg-surface-raised p-4 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
                <UsersIcon className="mb-3 size-5 text-primary" />
                以隊伍身分登入
              </div>
              <div className="rounded-[1rem] border-2 border-ink bg-surface-raised p-4 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
                <TurtleIcon className="mb-3 size-5 text-moss" />
                完成本回合作品
              </div>
              <div className="rounded-[1rem] border-2 border-ink bg-surface-raised p-4 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
                <ArrowRightIcon className="mb-3 size-5 text-secondary-foreground" />
                參與隊內與公開投票
              </div>
            </div>
          </section>
          <Card>
            <CardHeader>
              <div className="mb-2 flex size-12 items-center justify-center rounded-[1rem] border-2 border-ink bg-primary text-primary-foreground shadow-[2px_2px_0_rgba(23,35,58,0.16)]">
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
              <div className="flex items-center justify-between gap-3 text-sm font-bold text-muted-foreground">
                <span className="inline-flex items-center gap-2 text-ink">
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
