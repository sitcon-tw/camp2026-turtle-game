import { Fragment, useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { AdminSubmissionPreview } from "@/components/admin/AdminSubmissionPreview"
import { TurtlePreviewPanel } from "@/components/turtle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { BlackboardEvent, Challenge, Submission, SubmissionStatus, Team, TraceStep } from "@/lib/admin/types"

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return dateFormatter.format(new Date(value))
}

function statusBadge(status: SubmissionStatus) {
  if (status === "completed") return "secondary"
  if (status === "failed" || status === "cancelled") return "destructive"
  if (status === "running") return "default"
  return "outline"
}

function nameForTeam(teams: Team[] | undefined, id: string) {
  return teams?.find((team) => team.id === id)?.name ?? id.slice(0, 8)
}

function titleForChallenge(challenges: Challenge[] | undefined, id: string) {
  return challenges?.find((challenge) => challenge.id === id)?.title ?? id.slice(0, 8)
}

type LivePlayback = {
  submissionId: string
  canvasWidth: number
  canvasHeight: number
  stepCount: number | null
  currentStep: number | null
  steps: TraceStep[]
  completed: boolean
}

export default function AdminBlackboardPage() {
  const queryClient = useQueryClient()
  const [playback, setPlayback] = useState<LivePlayback | null>(null)
  const blackboard = useQuery({
    queryKey: ["admin", "blackboard"],
    queryFn: adminApi.blackboard,
    refetchInterval: 5_000,
  })
  const teams = useQuery({
    queryKey: ["admin", "teams", "blackboard"],
    queryFn: () => adminApi.teams({}),
  })
  const challenges = useQuery({
    queryKey: ["admin", "challenges", "blackboard"],
    queryFn: () => adminApi.challenges({}),
  })

  useEffect(() => {
    const events = new EventSource("/api/v1/blackboard/events")

    function invalidateBlackboard() {
      void queryClient.invalidateQueries({ queryKey: ["admin", "blackboard"] })
    }

    events.addEventListener("message", (message) => {
      const event = parseBlackboardEvent(message)
      if (!event) return

      switch (event.type) {
        case "judging_started":
          setPlayback({
            submissionId: event.submission_id,
            canvasWidth: event.canvas_width,
            canvasHeight: event.canvas_height,
            stepCount: event.step_count,
            currentStep: null,
            steps: [],
            completed: false,
          })
          invalidateBlackboard()
          break
        case "judging_step": {
          setPlayback((current) => {
            const base =
              current?.submissionId === event.submission_id
                ? current
                : {
                    submissionId: event.submission_id,
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
        }
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

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Blackboard state</CardTitle>
            <CardDescription>Public scoreboard feed status.</CardDescription>
            <CardAction>
              <Badge variant={blackboard.data?.paused ? "destructive" : "secondary"}>
                {blackboard.data?.status ?? "loading"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-3xl font-medium">{blackboard.data?.queue_length ?? 0}</div>
            <p className="text-sm text-muted-foreground">items in queue</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Running judges</CardTitle>
            <CardDescription>Submissions currently being evaluated.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-3xl font-medium">{blackboard.data?.running.length ?? 0}</div>
            <p className="text-sm text-muted-foreground">active submissions</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Leaderboard entries</CardTitle>
            <CardDescription>Teams visible on the blackboard.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-3xl font-medium">{blackboard.data?.leaderboard.length ?? 0}</div>
            <p className="text-sm text-muted-foreground">ranked teams</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live blackboard</CardTitle>
          <CardDescription>Read-only view of the public game state endpoint.</CardDescription>
          <CardAction>
            <Button variant="outline" onClick={() => void blackboard.refetch()}>
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {blackboard.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : blackboard.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Unable to load blackboard</EmptyTitle>
                <EmptyDescription>{errorMessage(blackboard.error)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !blackboard.data ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No blackboard data</EmptyTitle>
                <EmptyDescription>The blackboard endpoint did not return a payload.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Leaderboard</CardTitle>
                  <CardDescription>Current public ranking.</CardDescription>
                </CardHeader>
                <CardContent>
                  {blackboard.data.leaderboard.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>No leaderboard data</EmptyTitle>
                        <EmptyDescription>Scores will appear once teams earn points.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Rank</TableHead>
                          <TableHead>Team</TableHead>
                          <TableHead>Score</TableHead>
                          <TableHead>Solved</TableHead>
                          <TableHead>Last score</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {blackboard.data.leaderboard.map((team) => (
                          <TableRow key={team.team_id}>
                            <TableCell>{team.rank}</TableCell>
                            <TableCell>{team.team_name}</TableCell>
                            <TableCell>{team.total_score}</TableCell>
                            <TableCell>{team.solved_count}</TableCell>
                            <TableCell>{formatDate(team.last_score_event_at)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader>
                  <CardTitle>Running submissions</CardTitle>
                  <CardDescription>Judge tasks currently in progress.</CardDescription>
                </CardHeader>
                <CardContent>
                  {blackboard.data.running.length === 0 ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>No running submissions</EmptyTitle>
                        <EmptyDescription>The judge workers are idle right now.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>ID</TableHead>
                          <TableHead>Team</TableHead>
                          <TableHead>Challenge</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Started</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {blackboard.data.running.map((submission) => (
                          <Fragment key={submission.id}>
                            <TableRow>
                              <TableCell className="font-mono text-xs">{submission.id.slice(0, 8)}</TableCell>
                              <TableCell>{nameForTeam(teams.data, submission.team_id)}</TableCell>
                              <TableCell>{titleForChallenge(challenges.data, submission.challenge_id)}</TableCell>
                              <TableCell>
                                <Badge variant={statusBadge(submission.status)}>{submission.status}</Badge>
                              </TableCell>
                              <TableCell>{formatDate(submission.started_at)}</TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell colSpan={5}>
                                <LiveSubmissionPreview
                                  submission={submission}
                                  playback={playback?.submissionId === submission.id ? playback : null}
                                />
                              </TableCell>
                            </TableRow>
                          </Fragment>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function LiveSubmissionPreview({
  submission,
  playback,
}: {
  submission: Submission
  playback: LivePlayback | null
}) {
  if (!playback) {
    return <AdminSubmissionPreview submission={submission} compact className="w-full" />
  }

  return (
    <TurtlePreviewPanel
      trace={liveTraceFromPlayback(playback)}
      title="Live drawing"
      sourceLabel={playback.completed ? "finishing" : stepLabel(playback)}
      footerStart={stepLabel(playback)}
      footerEnd={`${visibleStrokeCount(playback.steps)} strokes`}
      animated={!playback.completed && playback.currentStep !== null}
      animationKey={`${playback.submissionId}:${playback.currentStep ?? "starting"}`}
      currentStepIndex={playback.currentStep ?? undefined}
      className="w-full"
      viewportClassName="h-44"
      showTarget={false}
      showTurtle
    />
  )
}

function stepLabel(playback: LivePlayback) {
  if (playback.currentStep === null) return playback.stepCount === null ? "starting" : `0 / ${playback.stepCount} steps`
  if (playback.stepCount === null) return `step ${playback.currentStep + 1}`
  return `${Math.min(playback.currentStep + 1, playback.stepCount)} / ${playback.stepCount} steps`
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
