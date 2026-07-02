import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ClockIcon } from "lucide-react"

import { TurtlePreviewPanel } from "@/components/turtle"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { BlackboardState, GamePhase, GameStateResponse, GameSubmission } from "@/lib/game/types"

export default function BlackboardPage() {
  const queryClient = useQueryClient()
  const blackboard = useQuery({
    queryKey: ["public", "blackboard"],
    queryFn: adminApi.blackboard,
    refetchInterval: 5_000,
  })

  useEffect(() => {
    const events = new EventSource("/api/v1/blackboard/events")
    events.addEventListener("message", () => {
      void queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] })
    })
    return () => events.close()
  }, [queryClient])

  if (blackboard.isLoading) {
    return (
      <main className="min-h-svh bg-background p-4 lg:p-8">
        <div className="mx-auto grid max-w-[1800px] gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-[680px]" />
        </div>
      </main>
    )
  }

  if (blackboard.isError || !blackboard.data) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background p-4">
        <Card className="w-full max-w-2xl">
          <CardContent className="pt-6">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>無法載入黑板</EmptyTitle>
                <EmptyDescription>{blackboard.isError ? errorMessage(blackboard.error) : "目前沒有黑板資料。"}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-svh bg-background p-4 lg:p-8">
      <div className="mx-auto grid max-w-[1800px] gap-4">
        <BlackboardHeader data={blackboard.data} />
        <PhaseView data={blackboard.data} />
      </div>
    </main>
  )
}

function BlackboardHeader({ data }: { data: BlackboardState }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <CardTitle className="text-4xl lg:text-6xl">Turtle Game</CardTitle>
              <Badge variant="secondary" className="text-lg">{phaseLabel(data.game.state.phase)}</Badge>
            </div>
            <CardDescription className="truncate text-xl">
              {data.game.challenge ? `${data.game.challenge.title} / ${data.game.challenge.description}` : "等待主持人開始回合"}
            </CardDescription>
          </div>
          <TimerBlock snapshot={data.game} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <LargeStat label="隊伍" value={data.teams.filter((team) => team.enabled).length} />
        <LargeStat label="提交" value={data.game.round_submissions.length} />
        <LargeStat label="代表作品" value={data.game.nominations.length} />
        <LargeStat label="狀態版本" value={data.game.state.version} />
      </CardContent>
    </Card>
  )
}

function PhaseView({ data }: { data: BlackboardState }) {
  if (data.game.state.phase === "submission_open") return <SubmissionOpenView data={data} />
  if (data.game.state.phase === "team_selection") return <TeamSelectionCountdown snapshot={data.game} />
  if (data.game.state.phase === "public_voting") return <PublicVotingView data={data} />
  if (data.game.state.phase === "round_complete" || data.game.state.phase === "scoring") return <RoundCompleteView data={data} />
  return <IdleView />
}

function SubmissionOpenView({ data }: { data: BlackboardState }) {
  const counts = countSubmissionsByTeam(data.game.round_submissions)
  const teams = data.teams.filter((team) => team.enabled)

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-3xl lg:text-5xl">各隊已送出作畫數</CardTitle>
        <CardDescription className="text-xl">Submission Open</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {teams.map((team) => (
          <div key={team.id} className="rounded-md border bg-muted/30 p-5">
            <div className="truncate text-2xl font-semibold">{team.name}</div>
            <div className="mt-6 font-mono text-7xl font-semibold tabular-nums">{counts.get(team.id) ?? 0}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function TeamSelectionCountdown({ snapshot }: { snapshot: GameStateResponse }) {
  const seconds = useRemainingSeconds(snapshot)

  return (
    <Card>
      <CardContent className="flex min-h-[58svh] flex-col items-center justify-center gap-6 text-center">
        <div className="flex items-center gap-3 text-2xl text-muted-foreground">
          <ClockIcon className="size-8" />
          Team Selection
        </div>
        <div className="font-mono text-8xl font-semibold tabular-nums lg:text-9xl">{formatTimer(seconds)}</div>
      </CardContent>
    </Card>
  )
}

function PublicVotingView({ data }: { data: BlackboardState }) {
  const submissionsById = useMemo(
    () => new Map(data.game.round_submissions.map((submission) => [submission.id, submission])),
    [data.game.round_submissions],
  )
  const teamsById = useMemo(() => new Map(data.teams.map((team) => [team.id, team])), [data.teams])
  const nominations = data.game.nominations
    .map((nomination) => ({
      nomination,
      submission: submissionsById.get(nomination.submission_id) ?? null,
      team: teamsById.get(nomination.team_id) ?? null,
      votes: data.game.public_vote_counts.find((count) => count.target_submission_id === nomination.submission_id)?.vote_count ?? 0,
    }))
    .sort((left, right) => right.votes - left.votes || (left.team?.name ?? "").localeCompare(right.team?.name ?? ""))

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-3xl lg:text-5xl">公開投票即時票數</CardTitle>
        <CardDescription className="text-xl">Public Voting</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
        {nominations.length === 0 ? (
          <div className="md:col-span-2 xl:col-span-3">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>尚無代表作品</EmptyTitle>
                <EmptyDescription>等待小隊選出代表作品。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          nominations.map(({ nomination, submission, team, votes }) => (
            <div key={nomination.team_id} className="grid gap-3 rounded-md border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="truncate text-2xl font-semibold">{team?.name ?? nomination.team_id.slice(0, 8)}</div>
                <div className="font-mono text-5xl font-semibold tabular-nums">{votes}</div>
              </div>
              <SubmissionPreview submission={submission} />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function RoundCompleteView({ data }: { data: BlackboardState }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-3xl lg:text-5xl">各小隊分數排行榜</CardTitle>
        <CardDescription className="text-xl">Round Complete</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4">
        {data.leaderboard.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>尚無分數</EmptyTitle>
              <EmptyDescription>回合結算後會顯示排行榜。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          data.leaderboard.slice(0, 12).map((team) => (
            <div key={team.team_id} className="grid grid-cols-[5rem_minmax(0,1fr)_10rem] items-center gap-4 rounded-md border bg-muted/30 p-4">
              <div className="font-mono text-4xl font-semibold tabular-nums">#{team.rank}</div>
              <div className="truncate text-3xl font-semibold">{team.team_name}</div>
              <div className="text-right font-mono text-5xl font-semibold tabular-nums">{team.total_score}</div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function IdleView() {
  return (
    <Card>
      <CardContent className="flex min-h-[58svh] items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-4xl">等待回合開始</EmptyTitle>
            <EmptyDescription className="text-xl">主持人開始後黑板會自動更新。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  )
}

function SubmissionPreview({ submission }: { submission: GameSubmission | null }) {
  if (!submission) {
    return <div className="rounded-md border border-dashed p-6 text-center text-xl text-muted-foreground">作品尚未載入</div>
  }

  return (
    <TurtlePreviewPanel
      program={submission.block_program}
      trace={submission.trace}
      resultImageUrl={submission.result_image_url}
      title="作品"
      sourceLabel={`#${submission.id.slice(0, 8)}`}
      className="h-[42svh] min-h-80 text-lg"
      viewportClassName="h-[calc(100%-5rem)]"
      showTarget={false}
      showTurtle={false}
    />
  )
}

function TimerBlock({ snapshot }: { snapshot: GameStateResponse }) {
  const seconds = useRemainingSeconds(snapshot)

  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <div className="flex items-center gap-2 text-lg text-muted-foreground">
        <ClockIcon className="size-5" />
        Timer
      </div>
      <div className="mt-3 font-mono text-5xl font-semibold tabular-nums">{formatTimer(seconds)}</div>
      <div className="mt-2 text-lg text-muted-foreground">server {formatClock(snapshot.state.server_now)}</div>
    </div>
  )
}

function LargeStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <div className="text-lg text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-4xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function useRemainingSeconds(snapshot: GameStateResponse) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!snapshot.state.phase_ends_at) return null
  return Math.max(0, Math.ceil((Date.parse(snapshot.state.phase_ends_at) - now) / 1_000))
}

function countSubmissionsByTeam(submissions: GameSubmission[]) {
  const counts = new Map<string, number>()
  for (const submission of submissions) counts.set(submission.team_id, (counts.get(submission.team_id) ?? 0) + 1)
  return counts
}

function phaseLabel(phase: GamePhase) {
  const labels: Record<GamePhase, string> = {
    idle: "等待中",
    submission_open: "小隊作畫",
    team_selection: "隊內選拔",
    public_voting: "公開投票",
    scoring: "結算中",
    round_complete: "回合結束",
  }
  return labels[phase]
}

function formatTimer(seconds: number | null) {
  if (seconds === null) return "--:--"
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value))
}
