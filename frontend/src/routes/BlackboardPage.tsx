import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { TurtlePreviewPanel } from "@/components/turtle"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { BlackboardEvent, LeaderboardResponse, Submission, TraceStep } from "@/lib/admin/types"
import { cn } from "@/lib/utils"

type LivePlayback = {
  submissionId: string
  teamId: string
  challengeId: string
  canvasWidth: number
  canvasHeight: number
  stepCount: number | null
  currentStep: number | null
  steps: TraceStep[]
  completed: boolean
}

export default function BlackboardPage() {
  const queryClient = useQueryClient()
  const [playback, setPlayback] = useState<LivePlayback | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null)
  const previousLeaderboard = useRef<LeaderboardResponse | null>(null)
  const changedLeaderboardTeams = useRef<Set<string>>(new Set())
  const [leaderboardAnimationTick, setLeaderboardAnimationTick] = useState(0)
  const blackboard = useQuery({
    queryKey: ["public", "blackboard"],
    queryFn: adminApi.blackboard,
    refetchInterval: 5_000,
  })

  useEffect(() => {
    const events = new EventSource("/api/v1/blackboard/events")

    function invalidateBlackboard() {
      void queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] })
    }

    events.addEventListener("message", (message) => {
      const event = parseBlackboardEvent(message)
      if (!event) return

      switch (event.type) {
        case "judging_started":
          setPlayback({
            submissionId: event.submission_id,
            teamId: event.team_id,
            challengeId: event.challenge_id,
            canvasWidth: event.canvas_width,
            canvasHeight: event.canvas_height,
            stepCount: event.step_count,
            currentStep: null,
            steps: [],
            completed: false,
          })
          invalidateBlackboard()
          break
        case "judging_step":
          setPlayback((current) => {
            const base =
              current?.submissionId === event.submission_id
                ? current
                : {
                    submissionId: event.submission_id,
                    teamId: event.team_id,
                    challengeId: event.challenge_id,
                    canvasWidth: event.canvas_width,
                    canvasHeight: event.canvas_height,
                    stepCount: null,
                    currentStep: null,
                    steps: [],
                    completed: false,
                  }

            return {
              ...base,
              canvasWidth: event.canvas_width,
              canvasHeight: event.canvas_height,
              currentStep: event.step.step_index,
              steps: [...base.steps, { ...event.step, duration_ms: event.playback_ms }],
            }
          })
          break
        case "judging_completed":
          setPlayback((current) =>
            current?.submissionId === event.submission_id ? { ...current, completed: true } : current,
          )
          invalidateBlackboard()
          break
        case "submission_updated":
        case "score_recorded":
          invalidateBlackboard()
          break
      }
    })

    return () => events.close()
  }, [queryClient])

  useEffect(() => {
    const events = new EventSource("/api/v1/leaderboard/events")
    let clearAnimation: number | undefined

    events.addEventListener("message", (message) => {
      const event = parseLeaderboardEvent(message)
      if (!event) return

      const changedTeams = changedTeamsForLeaderboard(previousLeaderboard.current, event)
      previousLeaderboard.current = event
      changedLeaderboardTeams.current = changedTeams
      setLeaderboard(event)
      setLeaderboardAnimationTick((value) => value + 1)

      if (clearAnimation !== undefined) window.clearTimeout(clearAnimation)
      clearAnimation = window.setTimeout(() => {
        changedLeaderboardTeams.current = new Set()
        setLeaderboardAnimationTick((value) => value + 1)
      }, 1_400)
    })

    return () => {
      if (clearAnimation !== undefined) window.clearTimeout(clearAnimation)
      events.close()
    }
  }, [])

  const currentSubmission = useMemo(() => {
    if (!blackboard.data) return null
    if (playback) {
      return blackboard.data.running.find((submission) => submission.id === playback.submissionId) ?? null
    }
    return blackboard.data.running[0] ?? null
  }, [blackboard.data, playback])
  const leaderboardTeams = leaderboard?.teams ?? blackboard.data?.leaderboard ?? []

  return (
    <main className="h-svh overflow-hidden bg-muted/30 p-5 lg:p-8">
      <div className="mx-auto flex h-full max-w-[1920px] flex-col gap-5">
        <Card className="shrink-0">
          <CardHeader className="flex-row items-center justify-between gap-6">
            <div>
              <CardDescription className="text-lg uppercase tracking-[0.28em]">Turtle Game</CardDescription>
              <CardTitle className="font-heading text-5xl lg:text-7xl">即時戰況黑板</CardTitle>
            </div>
            <CardAction className="flex items-center gap-3">
              <Badge variant={blackboard.data?.paused ? "destructive" : "secondary"} className="px-4 py-2 text-lg">
                {blackboard.data?.status ?? "loading"}
              </Badge>
              <Badge variant="outline" className="px-4 py-2 text-lg">
                佇列 {blackboard.data?.queue_length ?? 0}
              </Badge>
            </CardAction>
          </CardHeader>
        </Card>

        {blackboard.isLoading ? (
          <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
            <Skeleton className="h-full rounded-xl" />
            <Skeleton className="h-full rounded-xl" />
          </div>
        ) : blackboard.isError ? (
          <Card className="flex min-h-0 flex-1 items-center justify-center">
            <CardContent>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>無法載入戰況黑板</EmptyTitle>
                  <EmptyDescription>{errorMessage(blackboard.error)}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        ) : !blackboard.data ? (
          <Card className="flex min-h-0 flex-1 items-center justify-center">
            <CardContent>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>目前沒有戰況資料</EmptyTitle>
                  <EmptyDescription>正在等待戰況黑板資料。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
            <Card className="min-h-0 overflow-hidden">
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div>
                  <CardDescription className="text-lg uppercase tracking-[0.24em]">即時預覽</CardDescription>
                  <CardTitle className="font-heading text-4xl lg:text-5xl">
                    {currentSubmission || playback ? "正在繪圖" : "等待提交"}
                  </CardTitle>
                </div>
                <CardAction>
                  <Badge variant="outline" className="px-4 py-2 text-lg">
                    執行中 {blackboard.data.running.length}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="min-h-0 flex-1">
                <LiveSubmissionPreview
                  submission={currentSubmission}
                  playback={
                    playback && (!currentSubmission || playback.submissionId === currentSubmission.id) ? playback : null
                  }
                />
              </CardContent>
            </Card>

            <Card className="min-h-0 overflow-hidden">
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div>
                  <CardDescription className="text-lg uppercase tracking-[0.24em]">排行榜</CardDescription>
                  <CardTitle className="font-heading text-4xl lg:text-5xl">領先隊伍</CardTitle>
                </div>
                <CardAction>
                  <Badge variant="outline" className="px-4 py-2 text-lg">
                    {leaderboardTeams.length} 隊
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 overflow-hidden">
                {leaderboardTeams.length === 0 ? (
                  <Empty className="h-full">
                    <EmptyHeader>
                      <EmptyTitle>尚無分數</EmptyTitle>
                      <EmptyDescription>隊伍得分後會顯示在這裡。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xl">名次</TableHead>
                        <TableHead className="text-xl">隊伍</TableHead>
                        <TableHead className="text-right text-xl">分數</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leaderboardTeams.slice(0, 8).map((team) => (
                        <TableRow
                          key={`${team.team_id}-${leaderboardAnimationTick}`}
                          className={cn(
                            "blackboard-leaderboard-row",
                            team.rank <= 3 && "bg-muted/60",
                            changedLeaderboardTeams.current.has(team.team_id) && "blackboard-leaderboard-row-updated",
                          )}
                        >
                          <TableCell className="font-heading text-4xl font-semibold tabular-nums">
                            #{team.rank}
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-0 flex-col gap-1">
                              <span className="truncate text-2xl font-semibold lg:text-3xl">{team.team_name}</span>
                              <span className="text-lg text-muted-foreground">解出 {team.solved_count} 題</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-heading text-4xl font-semibold tabular-nums lg:text-5xl">
                            {team.total_score}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </main>
  )
}

function LiveSubmissionPreview({
  submission,
  playback,
}: {
  submission: Submission | null
  playback: LivePlayback | null
}) {
  if (playback) {
    return (
      <TurtlePreviewPanel
        trace={liveTraceFromPlayback(playback)}
        title="即時繪圖"
        sourceLabel={playback.completed ? "即將完成" : stepLabel(playback)}
        footerStart={stepLabel(playback)}
        footerEnd={`${visibleStrokeCount(playback.steps)} 筆畫`}
        animated={!playback.completed && playback.currentStep !== null}
        animationKey={`${playback.submissionId}:${playback.currentStep ?? "starting"}`}
        currentStepIndex={playback.currentStep ?? undefined}
        className="h-full w-full rounded-xl text-lg"
        viewportClassName="h-[calc(100%-5.5rem)]"
        canvasClassName="drop-shadow-2xl"
        showTarget={false}
        showTurtle
      />
    )
  }

  if (submission) {
    return (
      <TurtlePreviewPanel
        trace={submission.trace}
        program={submission.block_program}
        resultImageUrl={submission.result_image_url}
        title="目前提交"
        sourceLabel={submission.status}
        footerStart={submission.id.slice(0, 8)}
        footerEnd={submission.passed === null ? "評測中" : submission.passed ? "通過" : "未通過"}
        className="h-full w-full rounded-xl text-lg"
        viewportClassName="h-[calc(100%-5.5rem)]"
        canvasClassName="drop-shadow-2xl"
        showTarget={false}
        showTurtle={false}
      />
    )
  }

  return (
    <Empty className="h-full rounded-xl border">
      <EmptyHeader>
        <EmptyTitle className="font-heading text-5xl">評測目前閒置</EmptyTitle>
        <EmptyDescription className="text-2xl">下一張繪圖會顯示在這裡。</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function stepLabel(playback: LivePlayback) {
  if (playback.currentStep === null) return playback.stepCount === null ? "準備開始" : `0 / ${playback.stepCount} 步`
  if (playback.stepCount === null) return `第 ${playback.currentStep + 1} 步`
  return `${Math.min(playback.currentStep + 1, playback.stepCount)} / ${playback.stepCount} 步`
}

function liveTraceFromPlayback(playback: LivePlayback) {
  return {
    canvas_width: playback.canvasWidth,
    canvas_height: playback.canvasHeight,
    final_state: playback.steps.at(-1)?.after,
    steps: playback.steps,
  }
}

function visibleStrokeCount(steps: TraceStep[]) {
  let count = 0
  for (const step of steps) {
    if (step.block_type === "clear") {
      count = 0
      continue
    }
    if (step.draw_line) count += 1
  }
  return count
}

function parseBlackboardEvent(message: MessageEvent) {
  try {
    return JSON.parse(message.data) as BlackboardEvent
  } catch {
    return null
  }
}

function parseLeaderboardEvent(message: MessageEvent) {
  try {
    return JSON.parse(message.data) as LeaderboardResponse
  } catch {
    return null
  }
}

function changedTeamsForLeaderboard(
  previous: LeaderboardResponse | null,
  next: LeaderboardResponse,
) {
  if (!previous) return new Set<string>()

  const previousTeams = new Map(previous.teams.map((team) => [team.team_id, team]))
  const changedTeams = new Set<string>()
  for (const team of next.teams) {
    const previousTeam = previousTeams.get(team.team_id)
    if (!previousTeam) {
      changedTeams.add(team.team_id)
      continue
    }
    if (previousTeam.rank !== team.rank || previousTeam.total_score !== team.total_score) {
      changedTeams.add(team.team_id)
    }
  }
  return changedTeams
}
