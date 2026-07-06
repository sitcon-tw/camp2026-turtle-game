import { useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ClockIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  ScreenShareIcon,
  StepForwardIcon,
  TrophyIcon,
  WifiIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react"

import { TurtlePreviewPanel } from "@/components/turtle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { adminPreviewViewerSocketUrl, useBlackboardStreamViewer } from "@/hooks/use-blackboard-stream-viewer"
import { useGameEvents } from "@/hooks/use-game-events"
import { adminApi, errorMessage } from "@/lib/admin/api"
import { getAdminToken } from "@/lib/admin/session"
import type { Challenge, Team } from "@/lib/admin/types"
import type {
  BlackboardDisplayMode,
  BlackboardStreamSession,
  GamePhase,
  GameStateResponse,
  GameSubmission,
  LeaderboardEntry,
} from "@/lib/game/types"
import { cn } from "@/lib/utils"

type StartRoundForm = {
  challengeId: string
  submissionSeconds: string
  publicVotesPerTeam: string
}

const defaultStartRoundForm: StartRoundForm = {
  challengeId: "",
  submissionSeconds: "600",
  publicVotesPerTeam: "3",
}

export default function AdminCommandCenterPage() {
  const queryClient = useQueryClient()
  const token = getAdminToken()
  const [startForm, setStartForm] = useState<StartRoundForm>(defaultStartRoundForm)
  const [extendSeconds, setExtendSeconds] = useState("60")
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedReplayCue, setSelectedReplayCue] = useState<{ roundId: string | null; submissionId: string | null }>({
    roundId: null,
    submissionId: null,
  })

  const game = useQuery({
    queryKey: ["game", "state", "admin"],
    queryFn: adminApi.gameState,
    refetchInterval: 10_000,
  })
  const teams = useQuery({
    queryKey: ["admin", "teams", { enabled: null, search: "" }],
    queryFn: () => adminApi.teams({ enabled: null, search: "" }),
    refetchInterval: 15_000,
  })
  const challenges = useQuery({
    queryKey: ["admin", "challenges", "active"],
    queryFn: () => adminApi.challenges({ active_only: true }),
  })
  const leaderboard = useQuery({
    queryKey: ["leaderboard"],
    queryFn: adminApi.leaderboard,
    refetchInterval: 10_000,
  })
  const blackboard = useQuery({
    queryKey: ["public", "blackboard"],
    queryFn: adminApi.blackboard,
    refetchInterval: 5_000,
  })
  const blackboardControl = useQuery({
    queryKey: ["admin", "blackboard", "control"],
    queryFn: adminApi.blackboardControl,
    refetchInterval: 2_000,
  })

  const connectionState = useGameEvents({
    token,
    onSnapshot: (snapshot) => queryClient.setQueryData(["game", "state", "admin"], snapshot),
    onError: () => undefined,
  })

  const snapshot = game.data
  const currentRoundId = snapshot?.round?.id ?? null
  const selectedSubmissionId = selectedReplayCue.roundId === currentRoundId ? selectedReplayCue.submissionId : null
  const enabledChallenges = useMemo(
    () => (challenges.data ?? []).filter((challenge) => challenge.enabled).sort((left, right) => left.order - right.order),
    [challenges.data],
  )
  const allTeams = useMemo(() => teams.data ?? [], [teams.data])
  const teamNameById = useMemo(() => new Map(allTeams.map((team) => [team.id, team.name])), [allTeams])
  const leaderboardTeams = leaderboard.data?.teams ?? []

  const startRound = useMutation({
    mutationFn: () =>
      adminApi.startRound({
        challenge_id: startForm.challengeId,
        submission_seconds: positiveInteger(startForm.submissionSeconds, 600),
        public_votes_per_team: positiveInteger(startForm.publicVotesPerTeam, 3),
      }),
    onSuccess: async (response) => {
      queryClient.setQueryData(["game", "state", "admin"], response)
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] })
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const setPhase = useMutation({
    mutationFn: (phase: GamePhase) => adminApi.setGamePhase(phase),
    onSuccess: async (response) => {
      queryClient.setQueryData(["game", "state", "admin"], response)
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] })
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const extendTimer = useMutation({
    mutationFn: () => {
      if (!snapshot) throw new Error("No active game state")
      return adminApi.updateGameTimer({
        phase_ends_at: extendedDeadlineIso(snapshot, positiveInteger(extendSeconds, 60)),
      })
    },
    onSuccess: async (response) => {
      queryClient.setQueryData(["game", "state", "admin"], response)
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] })
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const scoreRound = useMutation({
    mutationFn: adminApi.scoreCurrentRound,
    onSuccess: async (response) => {
      queryClient.setQueryData(["game", "state", "admin"], response)
      setActionError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
      ])
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const playSubmission = useMutation({
    mutationFn: (submissionId: string) => adminApi.playSubmissionOnBlackboard(submissionId),
    onSuccess: async () => {
      setActionError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "blackboard", "control"] }),
      ])
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const clearBlackboardPlayback = useMutation({
    mutationFn: adminApi.clearBlackboardPlayback,
    onSuccess: async () => {
      setActionError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "blackboard", "control"] }),
      ])
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const setBlackboardDisplay = useMutation({
    mutationFn: adminApi.setBlackboardDisplay,
    onSuccess: async () => {
      setActionError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "blackboard", "control"] }),
      ])
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  if (game.isLoading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-44" />
        <Skeleton className="h-72" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (game.isError || !snapshot) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>無法載入遊戲控制台</EmptyTitle>
              <EmptyDescription>{game.isError ? errorMessage(game.error) : "目前沒有遊戲狀態。"}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-4">
      <CommandHeader
        snapshot={snapshot}
        connectionState={connectionState}
        teams={allTeams}
        leaderboard={leaderboardTeams}
      />

      {actionError ? (
        <Card>
          <CardContent className="py-3 text-sm text-destructive">{actionError}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Host Controls</CardTitle>
          <CardDescription>Start, advance, extend, and score the live round.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 pt-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <StartRoundPanel
              challenges={enabledChallenges}
              form={startForm}
              canStartRound={snapshot.state.phase === "idle" || snapshot.state.phase === "round_complete"}
              isPending={startRound.isPending}
              onChange={setStartForm}
              onStart={() => startRound.mutate()}
            />
            <TimerPanel
              snapshot={snapshot}
              extendSeconds={extendSeconds}
              isPending={extendTimer.isPending}
              onExtendSecondsChange={setExtendSeconds}
              onExtend={() => extendTimer.mutate()}
            />
          </div>
          <PhaseControls
            snapshot={snapshot}
            isSettingPhase={setPhase.isPending}
            isScoring={scoreRound.isPending}
            onPhase={(phase) => setPhase.mutate(phase)}
            onAdvance={() => {
              const next = nextPhase(snapshot.state.phase)
              if (next) setPhase.mutate(next)
            }}
            onScore={() => scoreRound.mutate()}
          />
        </CardContent>
      </Card>

      <BlackboardControlPanel
        snapshot={snapshot}
        teams={allTeams}
        mode={blackboardControl.data?.display.mode ?? blackboard.data?.display.mode ?? "submission"}
        selectedReplaySubmissionId={selectedSubmissionId}
        blackboardSelectedSubmissionId={blackboardControl.data?.display.selected_submission_id ?? blackboard.data?.selected_submission_id ?? null}
        selectedStreamSessionId={blackboardControl.data?.display.selected_stream_session_id ?? blackboard.data?.display.selected_stream_session_id ?? null}
        streamSessions={blackboardControl.data?.stream_sessions ?? blackboard.data?.stream_sessions ?? []}
        teamNameById={teamNameById}
        isPending={setBlackboardDisplay.isPending}
        playingSubmissionId={playSubmission.variables ?? null}
        isPlayingSubmission={playSubmission.isPending}
        isClearingBlackboard={clearBlackboardPlayback.isPending}
        onSelectSubmission={(submissionId) => setSelectedReplayCue({ roundId: currentRoundId, submissionId })}
        onPlaySubmission={(submissionId) => playSubmission.mutate(submissionId)}
        onClearBlackboard={() => clearBlackboardPlayback.mutate()}
        onSelectStream={(streamSessionId) => setBlackboardDisplay.mutate({ mode: "stream", stream_session_id: streamSessionId })}
        onRefresh={() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] }),
            queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] }),
            queryClient.invalidateQueries({ queryKey: ["admin", "blackboard", "control"] }),
          ])
        }}
      />

      <LiveRoundMonitor
        snapshot={snapshot}
        leaderboard={leaderboardTeams}
        teamNameById={teamNameById}
        onRefresh={() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] }),
            queryClient.invalidateQueries({ queryKey: ["admin", "teams"] }),
            queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
            queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] }),
            queryClient.invalidateQueries({ queryKey: ["admin", "blackboard", "control"] }),
          ])
        }}
      />
    </div>
  )
}

function CommandHeader({
  snapshot,
  connectionState,
  teams,
  leaderboard,
}: {
  snapshot: GameStateResponse
  connectionState: string
  teams: Team[]
  leaderboard: LeaderboardEntry[]
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <CardTitle className="text-2xl">Admin Command Center</CardTitle>
              <PhaseBadge phase={snapshot.state.phase} />
              <Badge variant={connectionState === "open" ? "secondary" : "outline"}>
                {connectionState === "open" ? "Live" : "Sync"}
              </Badge>
            </div>
            <CardDescription className="truncate">
              {snapshot.challenge ? `${snapshot.challenge.title} / ${snapshot.challenge.description}` : "No active round"}
            </CardDescription>
          </div>
          <HeaderTimer snapshot={snapshot} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Round" value={snapshot.round?.id.slice(0, 8) ?? "none"} />
        <StatTile label="Teams" value={`${teams.filter((team) => team.enabled).length}/${teams.length}`} />
        <StatTile label="Submissions" value={snapshot.round_submissions.length} />
        <StatTile label="Nominations" value={snapshot.nominations.length} />
        <StatTile label="Leader" value={leaderboard[0]?.team_name ?? "none"} />
      </CardContent>
    </Card>
  )
}

function HeaderTimer({ snapshot }: { snapshot: GameStateResponse }) {
  const seconds = useRemainingSeconds(snapshot)
  return (
    <div className="rounded-[1rem] border-2 border-ink bg-surface-raised p-3 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
      <div className="flex items-center gap-2 text-sm font-black text-muted-foreground">
        <ClockIcon className="size-4" />
        Timer
      </div>
      <div className="mt-2 font-mono text-3xl font-black tabular-nums">{formatTimer(seconds)}</div>
      <div className="mt-1 text-xs font-bold text-muted-foreground">server {formatClock(snapshot.state.server_now)}</div>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[1rem] border-2 border-ink bg-surface-raised p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]">
      <div className="text-sm font-black text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-black">{value}</div>
    </div>
  )
}

function StartRoundPanel({
  challenges,
  form,
  canStartRound,
  isPending,
  onChange,
  onStart,
}: {
  challenges: Challenge[]
  form: StartRoundForm
  canStartRound: boolean
  isPending: boolean
  onChange: (form: StartRoundForm) => void
  onStart: () => void
}) {
  return (
    <div className="rounded-[1rem] border-2 border-ink bg-surface-raised p-4 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
      <div className="mb-4">
        <h2 className="font-black">Start Round</h2>
        <p className="text-sm font-semibold text-muted-foreground">Uses enabled challenges from the active challenge set.</p>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel>Challenge</FieldLabel>
          <Select
            items={challenges.map((challenge) => ({ value: challenge.id, label: challenge.title }))}
            value={form.challengeId}
            onValueChange={(value) => onChange({ ...form, challengeId: value ?? "" })}
          >
            <SelectTrigger className="w-full" aria-label="Challenge">
              <SelectValue placeholder="Select challenge" />
            </SelectTrigger>
            <SelectContent>
              {challenges.map((challenge) => (
                <SelectItem key={challenge.id} value={challenge.id}>
                  {challenge.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="submission-seconds">Submission seconds</FieldLabel>
            <Input
              id="submission-seconds"
              inputMode="numeric"
              value={form.submissionSeconds}
              onChange={(event) => onChange({ ...form, submissionSeconds: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="public-votes-per-team">Votes per team</FieldLabel>
            <Input
              id="public-votes-per-team"
              inputMode="numeric"
              value={form.publicVotesPerTeam}
              onChange={(event) => onChange({ ...form, publicVotesPerTeam: event.target.value })}
            />
          </Field>
        </div>
        <Button disabled={!form.challengeId || !canStartRound || isPending} onClick={onStart}>
          {isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <PlayIcon data-icon="inline-start" />}
          {canStartRound ? "Start Round" : "Round Active"}
        </Button>
      </FieldGroup>
    </div>
  )
}

function TimerPanel({
  snapshot,
  extendSeconds,
  isPending,
  onExtendSecondsChange,
  onExtend,
}: {
  snapshot: GameStateResponse
  extendSeconds: string
  isPending: boolean
  onExtendSecondsChange: (value: string) => void
  onExtend: () => void
}) {
  const canExtend = Boolean(snapshot.state.phase_ends_at)

  return (
    <div className="rounded-[1rem] border-2 border-ink bg-surface-raised p-4 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
      <div className="mb-4">
        <h2 className="font-black">Timer</h2>
        <p className="text-sm font-semibold text-muted-foreground">Current phase deadline is extended from the later of server time or deadline.</p>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="extend-seconds">Extend seconds</FieldLabel>
          <Input
            id="extend-seconds"
            inputMode="numeric"
            value={extendSeconds}
            disabled={!canExtend}
            onChange={(event) => onExtendSecondsChange(event.target.value)}
          />
        </Field>
        <Button variant="outline" disabled={!canExtend || isPending} onClick={onExtend}>
          {isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <ClockIcon data-icon="inline-start" />}
          Extend Timer
        </Button>
      </FieldGroup>
    </div>
  )
}

function PhaseControls({
  snapshot,
  isSettingPhase,
  isScoring,
  onPhase,
  onAdvance,
  onScore,
}: {
  snapshot: GameStateResponse
  isSettingPhase: boolean
  isScoring: boolean
  onPhase: (phase: GamePhase) => void
  onAdvance: () => void
  onScore: () => void
}) {
  const next = nextPhase(snapshot.state.phase)

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 sm:grid-cols-4">
        {(["submission_open", "team_selection", "public_voting", "round_complete"] satisfies GamePhase[]).map((phase) => (
          <Button
            key={phase}
            variant={snapshot.state.phase === phase ? "secondary" : "outline"}
            disabled={isSettingPhase || snapshot.state.phase === "idle"}
            onClick={() => onPhase(phase)}
          >
            {phaseLabel(phase)}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <Button disabled={!next || isSettingPhase} onClick={onAdvance}>
          {isSettingPhase ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <StepForwardIcon data-icon="inline-start" />}
          Advance Phase
        </Button>
        <Button
          variant="outline"
          disabled={isScoring || snapshot.state.phase === "idle"}
          onClick={onScore}
        >
          {isScoring ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <TrophyIcon data-icon="inline-start" />}
          Score Round
        </Button>
      </div>
      <PhaseTimeline phase={snapshot.state.phase} />
    </div>
  )
}

function PhaseTimeline({ phase }: { phase: GamePhase }) {
  const phases: GamePhase[] = ["submission_open", "team_selection", "public_voting", "round_complete"]
  const currentIndex = phases.indexOf(phase)
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      {phases.map((item, index) => (
        <div key={item} className="rounded-[1rem] border-2 border-ink bg-surface-raised p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]">
          <div className="text-sm font-black text-muted-foreground">Step {index + 1}</div>
          <div className="font-black">{phaseLabel(item)}</div>
          <Badge className="mt-2" variant={index === currentIndex ? "secondary" : index < currentIndex ? "outline" : "outline"}>
            {index === currentIndex ? "Current" : index < currentIndex ? "Done" : "Pending"}
          </Badge>
        </div>
      ))}
    </div>
  )
}

function BlackboardControlPanel({
  snapshot,
  teams,
  mode,
  selectedReplaySubmissionId,
  blackboardSelectedSubmissionId,
  selectedStreamSessionId,
  streamSessions,
  teamNameById,
  isPending,
  playingSubmissionId,
  isPlayingSubmission,
  isClearingBlackboard,
  onSelectSubmission,
  onPlaySubmission,
  onClearBlackboard,
  onSelectStream,
  onRefresh,
}: {
  snapshot: GameStateResponse
  teams: Team[]
  mode: BlackboardDisplayMode
  selectedReplaySubmissionId: string | null
  blackboardSelectedSubmissionId: string | null
  selectedStreamSessionId: string | null
  streamSessions: BlackboardStreamSession[]
  teamNameById: Map<string, string>
  isPending: boolean
  playingSubmissionId: string | null
  isPlayingSubmission: boolean
  isClearingBlackboard: boolean
  onSelectSubmission: (submissionId: string) => void
  onPlaySubmission: (submissionId: string) => void
  onClearBlackboard: () => void
  onSelectStream: (streamSessionId: string) => void
  onRefresh: () => void
}) {
  const [activeTab, setActiveTab] = useState<BlackboardDisplayMode>(mode)
  const [activeStreamTeamId, setActiveStreamTeamId] = useState<string | null>(null)
  const blackboardSubmission = blackboardSelectedSubmissionId
    ? snapshot.round_submissions.find((submission) => submission.id === blackboardSelectedSubmissionId) ?? null
    : null
  const selectedStreamSession = selectedStreamSessionId
    ? streamSessions.find((session) => session.session_id === selectedStreamSessionId) ?? null
    : null
  const blackboardOutputLabel = mode === "stream"
    ? selectedStreamSession
      ? `${teamNameById.get(selectedStreamSession.team_id) ?? selectedStreamSession.team_id.slice(0, 8)} ${selectedStreamSession.label}`
      : "Live stream"
    : blackboardSubmission
      ? `${teamNameById.get(blackboardSubmission.team_id) ?? blackboardSubmission.team_id.slice(0, 8)} #${blackboardSubmission.attempt_no}`
      : "Submission counts"
  const sessionsByTeam = useMemo(() => {
    const grouped = new Map<string, BlackboardStreamSession[]>()
    for (const session of streamSessions) {
      const sessions = grouped.get(session.team_id) ?? []
      sessions.push(session)
      grouped.set(session.team_id, sessions)
    }
    return [...grouped.entries()].sort((left, right) => {
      const leftName = teamNameById.get(left[0]) ?? left[0]
      const rightName = teamNameById.get(right[0]) ?? right[0]
      return leftName.localeCompare(rightName)
    })
  }, [streamSessions, teamNameById])
  const firstStreamTeamId = sessionsByTeam[0]?.[0] ?? null
  const selectedStreamTeamId = sessionsByTeam.some(([teamId]) => teamId === activeStreamTeamId)
    ? activeStreamTeamId
    : firstStreamTeamId

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Blackboard Controls</CardTitle>
            <CardDescription>Choose exactly what appears on the public blackboard.</CardDescription>
          </div>
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4">
        <div className="grid gap-3 rounded-[1rem] border-2 border-ink bg-surface-raised p-4 shadow-[3px_3px_0_rgba(23,35,58,0.12)] md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div className="min-w-0">
            <div className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">Public board output</div>
            <div className="mt-1 truncate text-xl font-black">{blackboardOutputLabel}</div>
            <div className="mt-1 text-sm font-semibold text-muted-foreground">
              {phaseLabel(snapshot.state.phase)} / {snapshot.challenge?.title ?? "No active challenge"} / {formatTimerValue(snapshot.state.phase_ends_at, snapshot.state.server_now)}
            </div>
          </div>
          <Badge variant={mode === "stream" ? "secondary" : "outline"} className="w-fit font-black">
            {mode === "stream" ? "Live Stream" : blackboardSubmission ? "Submission Replay" : "Counts"}
          </Badge>
        </div>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (value === "submission" || value === "stream") {
              setActiveTab(value)
            }
          }}
        >
          <TabsList className="w-full flex-wrap justify-start">
            <TabsTrigger value="stream">
              <ScreenShareIcon data-icon="inline-start" />
              Live Streams
            </TabsTrigger>
            <TabsTrigger value="submission">
              <PlayIcon data-icon="inline-start" />
              Submissions
            </TabsTrigger>
          </TabsList>
          <TabsContent value="stream" className="mt-4">
            {sessionsByTeam.length === 0 ? (
              <EmptyPanel title="No stream sessions" description="Team stations appear here after students allow screen streaming." />
            ) : (
              <Tabs
                value={selectedStreamTeamId ?? undefined}
                onValueChange={setActiveStreamTeamId}
                orientation="vertical"
                className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]"
              >
                <TabsList className="w-full">
                  {sessionsByTeam.map(([teamId, sessions]) => (
                    <TabsTrigger key={teamId} value={teamId} className="justify-start">
                      {teamNameById.get(teamId) ?? teamId.slice(0, 8)}
                      <Badge variant="outline" className="ml-auto">{sessions.length}</Badge>
                    </TabsTrigger>
                  ))}
                </TabsList>
                {sessionsByTeam.map(([teamId, sessions]) => (
                  <TabsContent key={teamId} value={teamId}>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {sessions.map((session) => (
                        <StreamSessionCard
                          key={session.session_id}
                          session={session}
                          teamName={teamNameById.get(session.team_id) ?? session.team_id.slice(0, 8)}
                          selected={session.session_id === selectedStreamSessionId && mode === "stream"}
                          previewEnabled={activeTab === "stream" && selectedStreamTeamId === teamId}
                          isPending={isPending}
                          onSelect={() => onSelectStream(session.session_id)}
                        />
                      ))}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            )}
          </TabsContent>
          <TabsContent value="submission" className="mt-4">
            <SubmissionReplayDeck
              snapshot={snapshot}
              teams={teams}
              mode={mode}
              teamNameById={teamNameById}
              selectedSubmissionId={selectedReplaySubmissionId}
              blackboardSelectedSubmissionId={blackboardSelectedSubmissionId}
              playingSubmissionId={playingSubmissionId}
              isPlayingSubmission={isPlayingSubmission}
              isClearingBlackboard={isClearingBlackboard}
              onSelectSubmission={onSelectSubmission}
              onPlaySubmission={onPlaySubmission}
              onClearBlackboard={onClearBlackboard}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function StreamSessionCard({
  session,
  teamName,
  selected,
  previewEnabled,
  isPending,
  onSelect,
}: {
  session: BlackboardStreamSession
  teamName: string
  selected: boolean
  previewEnabled: boolean
  isPending: boolean
  onSelect: () => void
}) {
  const {
    containerRef: previewContainerRef,
    videoRef: previewVideoRef,
    isVisible: previewVisible,
    status: previewStatus,
    fps: previewFps,
    targetFps: previewTargetFps,
  } = useAdminPreviewStream(session.session_id, previewEnabled && session.connected)
  const isPreviewLive = previewStatus === "live"
  return (
    <article
      className={cn(
        "grid gap-3 rounded-[1rem] border-2 bg-card p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]",
        selected ? "border-primary" : "border-ink",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-black">{teamName}</div>
          <div className="text-sm font-semibold text-muted-foreground">{session.label}</div>
        </div>
        <Badge variant={session.connected ? "secondary" : "outline"} className="font-black">
          {session.connected ? <WifiIcon data-icon="inline-start" /> : <WifiOffIcon data-icon="inline-start" />}
          {session.connected ? "Live" : "Offline"}
        </Badge>
      </div>
      <StreamSessionThumbnail
        containerRef={previewContainerRef}
        videoRef={previewVideoRef}
        alt={`${teamName} ${session.label}`}
        isLive={isPreviewLive}
        statusLabel={thumbnailStatusLabel(previewEnabled && session.connected, previewVisible, previewStatus)}
      />
      <div className="grid grid-cols-3 gap-2 text-center">
        <ReplayStat label="target" value={previewTargetFps ? `${previewTargetFps} fps` : "2 fps"} />
        <ReplayStat label="video" value={previewFps ? Math.round(previewFps) : "-"} />
        <ReplayStat label="seen" value={formatSubmissionTime(session.last_seen_at)} />
      </div>
      <Button disabled={isPending || !session.connected} onClick={onSelect}>
        {isPending && selected ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <ScreenShareIcon data-icon="inline-start" />}
        {selected ? "On Blackboard" : "Stream on Blackboard"}
      </Button>
    </article>
  )
}

function useAdminPreviewStream(sessionId: string, enabled: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isVisible = useElementVisible(containerRef)
  const token = getAdminToken()
  const hello = useMemo(() => token ? { type: "hello", token } : null, [token])
  const streamMedia = useBlackboardStreamViewer({
    sessionId,
    enabled: enabled && isVisible && Boolean(token),
    url: adminPreviewViewerSocketUrl(sessionId),
    hello,
  })

  return {
    containerRef,
    isVisible,
    ...streamMedia,
  }
}

function StreamSessionThumbnail({
  containerRef,
  videoRef,
  alt,
  isLive,
  statusLabel,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  alt: string
  isLive: boolean
  statusLabel: string
}) {
  return (
    <div ref={containerRef} className="aspect-video overflow-hidden rounded-[0.875rem] border-2 border-ink bg-background">
      <video
        ref={videoRef}
        aria-label={alt}
        autoPlay
        muted
        playsInline
        className={cn("h-full w-full object-contain", isLive ? "block" : "hidden")}
      />
      {!isLive ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-sm font-semibold text-muted-foreground">
          {statusLabel}
        </div>
      ) : null}
    </div>
  )
}

function useElementVisible(ref: RefObject<Element | null>) {
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === "undefined")

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: "160px", threshold: 0.1 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return isVisible
}

function thumbnailStatusLabel(enabled: boolean, isVisible: boolean, status: string) {
  if (!enabled) return "Stream offline"
  if (!isVisible) return "Preview paused"
  if (status === "unsupported") return "WebRTC unsupported"
  if (status === "error") return "Preview unavailable"
  if (status === "connecting") return "Connecting preview"
  return "Waiting for preview"
}

function LiveRoundMonitor({
  snapshot,
  leaderboard,
  teamNameById,
  onRefresh,
}: {
  snapshot: GameStateResponse
  leaderboard: LeaderboardEntry[]
  teamNameById: Map<string, string>
  onRefresh: () => void
}) {
  const defaultTab = monitorDefaultTab(snapshot.state.phase)

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Live Round Monitor</CardTitle>
            <CardDescription>Read-only nominations, public votes, results, and leaderboard context.</CardDescription>
          </div>
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <Tabs key={defaultTab} defaultValue={defaultTab}>
          <TabsList className="w-full flex-wrap justify-start">
            <TabsTrigger value="nominations">Nominations</TabsTrigger>
            <TabsTrigger value="votes">Votes</TabsTrigger>
            <TabsTrigger value="results">Results</TabsTrigger>
            <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
          </TabsList>
          <TabsContent value="nominations" className="mt-4">
            <NominationGrid snapshot={snapshot} teamNameById={teamNameById} />
          </TabsContent>
          <TabsContent value="votes" className="mt-4">
            <VoteGrid snapshot={snapshot} teamNameById={teamNameById} />
          </TabsContent>
          <TabsContent value="results" className="mt-4">
            <ResultGrid snapshot={snapshot} teamNameById={teamNameById} />
          </TabsContent>
          <TabsContent value="leaderboard" className="mt-4">
            <LeaderboardList leaderboard={leaderboard} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function SubmissionReplayDeck({
  snapshot,
  teams,
  mode,
  teamNameById,
  selectedSubmissionId,
  blackboardSelectedSubmissionId,
  playingSubmissionId,
  isPlayingSubmission,
  isClearingBlackboard,
  onSelectSubmission,
  onPlaySubmission,
  onClearBlackboard,
}: {
  snapshot: GameStateResponse
  teams: Team[]
  mode: BlackboardDisplayMode
  teamNameById: Map<string, string>
  selectedSubmissionId: string | null
  blackboardSelectedSubmissionId: string | null
  playingSubmissionId: string | null
  isPlayingSubmission: boolean
  isClearingBlackboard: boolean
  onSelectSubmission: (submissionId: string) => void
  onPlaySubmission: (submissionId: string) => void
  onClearBlackboard: () => void
}) {
  const submissions = useMemo(() => sortSubmissionsByRecency(snapshot.round_submissions), [snapshot.round_submissions])
  const previewSubmissionId = selectedSubmissionId ?? blackboardSelectedSubmissionId
  const selectedSubmission = previewSubmissionId
    ? submissions.find((submission) => submission.id === previewSubmissionId) ?? null
    : null
  const blackboardSubmission = blackboardSelectedSubmissionId
    ? submissions.find((submission) => submission.id === blackboardSelectedSubmissionId) ?? null
    : null
  const completedCount = submissions.filter((submission) => submission.status === "completed").length
  const activeTeamCount = new Set(submissions.map((submission) => submission.team_id)).size
  const enabledTeamCount = teams.filter((team) => team.enabled).length

  if (submissions.length === 0) {
    return (
      <EmptyPanel
        title="No submissions yet"
        description="As teams submit drawings, this becomes the live replay deck for the classroom blackboard."
      />
    )
  }

  const selectedCanPlay = Boolean(selectedSubmission?.trace && selectedSubmission.status === "completed")
  const canClearToCounts = mode !== "submission" || Boolean(blackboardSelectedSubmissionId)

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(22rem,0.92fr)]">
      <section className="overflow-hidden rounded-[1.25rem] border-2 border-ink bg-[radial-gradient(circle_at_top_left,rgba(250,204,21,0.18),transparent_34%),linear-gradient(135deg,hsl(var(--surface-raised)),hsl(var(--card)))] shadow-[4px_4px_0_rgba(23,35,58,0.14)]">
        <div className="flex flex-col gap-3 border-b-2 border-ink bg-card/90 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-black uppercase tracking-[0.22em] text-muted-foreground">Blackboard Replay Deck</div>
            <h2 className="mt-1 truncate text-2xl font-black">Pick the next crowd moment</h2>
            <p className="mt-1 text-sm font-semibold text-muted-foreground">
              Only the played submission appears on the public board during Submission Open.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center sm:min-w-72">
            <ReplayStat label="total" value={submissions.length} />
            <ReplayStat label="ready" value={completedCount} />
            <ReplayStat label="teams" value={`${activeTeamCount}/${enabledTeamCount}`} />
          </div>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="min-w-0">
            {selectedSubmission ? (
              <SubmissionPreview
                submission={selectedSubmission}
                challenge={snapshot.challenge}
                title={`${teamNameById.get(selectedSubmission.team_id) ?? "Team"} #${selectedSubmission.attempt_no}`}
                sourceLabel={submissionStatusLabel(selectedSubmission)}
                className="h-[26rem]"
                viewportClassName="h-[calc(100%-4.5rem)]"
                animated={selectedCanPlay}
                animationKey={`admin-selected:${selectedSubmission.id}`}
                showTurtle={selectedCanPlay}
              />
            ) : (
              <EmptyPanel
                title="No submission selected"
                description="The public blackboard stays on team submission counts until a completed submission is played."
              />
            )}
          </div>
          <aside className="grid content-between gap-3 rounded-[1rem] border-2 border-ink bg-background/80 p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]">
            <div className="grid gap-3">
              <div>
                <div className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">Preview</div>
                <div className="mt-1 text-xl font-black">
                  {selectedSubmission ? teamNameById.get(selectedSubmission.team_id) ?? selectedSubmission.team_id.slice(0, 8) : "None"}
                </div>
                <div className="mt-1 text-sm font-semibold text-muted-foreground">
                  {selectedSubmission ? `Attempt #${selectedSubmission.attempt_no} / ${formatSubmissionTime(selectedSubmission.created_at)}` : "Choose a drawing"}
                </div>
              </div>
              {selectedSubmission ? (
                <div className="grid gap-2">
                  <Badge variant={selectedCanPlay ? "secondary" : "outline"} className="w-fit font-black">
                    {selectedCanPlay ? "Ready to play" : submissionStatusLabel(selectedSubmission)}
                  </Badge>
                  <div className="text-sm font-semibold text-muted-foreground">
                    {selectedCanPlay
                      ? "Sends this trace to the public blackboard spotlight."
                      : "Replay unlocks after the judge finishes the trace."}
                  </div>
                </div>
              ) : null}
              <div className="rounded-[0.875rem] border border-border bg-card/80 px-3 py-3">
                <div className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">Public board</div>
                <div className="mt-1 truncate font-black">
                  {blackboardSubmission
                    ? `${teamNameById.get(blackboardSubmission.team_id) ?? blackboardSubmission.team_id.slice(0, 8)} #${blackboardSubmission.attempt_no}`
                    : "Submission counts"}
                </div>
                <div className="mt-1 text-xs font-bold text-muted-foreground">
                  {mode === "stream" ? "Live stream is currently active" : blackboardSubmission ? "Replay is currently active" : "Default counts are live"}
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              <Button
                size="lg"
                disabled={!selectedSubmission || !selectedCanPlay || isPlayingSubmission}
                onClick={() => selectedSubmission ? onPlaySubmission(selectedSubmission.id) : undefined}
              >
                {isPlayingSubmission && playingSubmissionId === selectedSubmission?.id ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                Play on Blackboard
              </Button>
              <Button
                variant="outline"
                disabled={!canClearToCounts || isClearingBlackboard}
                onClick={onClearBlackboard}
              >
                {isClearingBlackboard ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <XIcon data-icon="inline-start" />
                )}
                Clear to Counts
              </Button>
            </div>
          </aside>
        </div>
      </section>

      <section className="rounded-[1.25rem] border-2 border-ink bg-surface-raised p-3 shadow-[4px_4px_0_rgba(23,35,58,0.12)]">
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <div>
            <h3 className="font-black">Recent submissions</h3>
            <p className="text-sm font-semibold text-muted-foreground">Newest first. Click any card to cue it.</p>
          </div>
          <Badge variant="outline" className="font-mono font-black">{submissions.length}</Badge>
        </div>
        <div className="grid max-h-[38rem] gap-3 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          {submissions.map((submission) => (
            <SubmissionReplayCard
              key={submission.id}
              submission={submission}
              teamName={teamNameById.get(submission.team_id) ?? submission.team_id.slice(0, 8)}
              selected={submission.id === selectedSubmission?.id}
              onBoard={submission.id === blackboardSelectedSubmissionId}
              onSelect={() => onSelectSubmission(submission.id)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function ReplayStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[0.875rem] border border-border bg-background/75 px-2 py-2 shadow-[1px_1px_0_rgba(23,35,58,0.08)]">
      <div className="text-[0.65rem] font-black uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="font-mono text-xl font-black tabular-nums">{value}</div>
    </div>
  )
}

function SubmissionReplayCard({
  submission,
  teamName,
  selected,
  onBoard,
  onSelect,
}: {
  submission: GameSubmission
  teamName: string
  selected: boolean
  onBoard: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group grid gap-3 rounded-[1rem] border-2 p-3 text-left shadow-[2px_2px_0_rgba(23,35,58,0.1)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(23,35,58,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/10" : onBoard ? "border-primary bg-card" : "border-ink bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-black">{teamName}</div>
          <div className="text-sm font-semibold text-muted-foreground">
            Attempt #{submission.attempt_no} / {formatSubmissionTime(submission.created_at)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {onBoard ? <Badge className="font-black">On board</Badge> : null}
          <Badge variant={submission.status === "completed" ? "secondary" : "outline"} className="font-black">
            {submissionStatusLabel(submission)}
          </Badge>
        </div>
      </div>
      <div className="aspect-[4/3] overflow-hidden rounded-[0.875rem] border-2 border-ink bg-background">
        {submission.result_image_url ? (
          <img
            src={submission.result_image_url}
            alt={`${teamName} attempt ${submission.attempt_no}`}
            className="h-full w-full object-contain transition duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm font-semibold text-muted-foreground">
            {submission.error_message ?? "Trace is being prepared"}
          </div>
        )}
      </div>
    </button>
  )
}

function NominationGrid({ snapshot, teamNameById }: { snapshot: GameStateResponse; teamNameById: Map<string, string> }) {
  const submissionsById = new Map(snapshot.round_submissions.map((submission) => [submission.id, submission]))

  if (snapshot.nominations.length === 0) return <EmptyPanel title="No nominations" description="Nominations appear after team selection votes are recorded." />

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {snapshot.nominations.map((nomination) => {
        const submission = submissionsById.get(nomination.submission_id)
        return (
          <div key={nomination.team_id} className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="truncate font-medium">{teamNameById.get(nomination.team_id) ?? nomination.team_id.slice(0, 8)}</div>
              <Badge variant="outline">{nomination.vote_count} team votes</Badge>
            </div>
            <SubmissionPreview submission={submission} />
          </div>
        )
      })}
    </div>
  )
}

function VoteGrid({ snapshot, teamNameById }: { snapshot: GameStateResponse; teamNameById: Map<string, string> }) {
  const submissionsById = new Map(snapshot.round_submissions.map((submission) => [submission.id, submission]))
  const nominations = snapshot.nominations.map((nomination) => ({
    nomination,
    submission: submissionsById.get(nomination.submission_id),
    votes: snapshot.public_vote_counts.find((count) => count.target_submission_id === nomination.submission_id)?.vote_count ?? 0,
  }))

  if (nominations.length === 0) return <EmptyPanel title="No public vote targets" description="Representative drawings appear here in public voting." />

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {nominations.map(({ nomination, submission, votes }) => (
        <div key={nomination.team_id} className="grid gap-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate font-medium">{teamNameById.get(nomination.team_id) ?? nomination.team_id.slice(0, 8)}</div>
            <Badge variant="secondary">{votes} votes</Badge>
          </div>
          <SubmissionPreview submission={submission} />
        </div>
      ))}
    </div>
  )
}

function ResultGrid({ snapshot, teamNameById }: { snapshot: GameStateResponse; teamNameById: Map<string, string> }) {
  const submissionsById = new Map(snapshot.round_submissions.map((submission) => [submission.id, submission]))

  if (snapshot.results.length === 0) return <EmptyPanel title="No results" description="Results appear after scoring the round." />

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {snapshot.results.map((result) => {
        const submission = submissionsById.get(result.submission_id)
        return (
          <div key={result.submission_id} className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold">#{result.rank}</div>
                <div className="text-sm text-muted-foreground">{teamNameById.get(result.team_id) ?? result.team_id.slice(0, 8)}</div>
              </div>
              <Badge variant="secondary">+{result.placement_points + result.streak_bonus}</Badge>
            </div>
            <SubmissionPreview submission={submission} />
          </div>
        )
      })}
    </div>
  )
}

function SubmissionPreview({
  submission,
  challenge,
  title,
  sourceLabel,
  className = "h-64",
  viewportClassName = "h-[calc(100%-4.5rem)]",
  animated = false,
  animationKey,
  showTurtle = false,
}: {
  submission?: GameSubmission
  challenge?: GameStateResponse["challenge"]
  title?: string
  sourceLabel?: string
  className?: string
  viewportClassName?: string
  animated?: boolean
  animationKey?: string | number
  showTurtle?: boolean
}) {
  if (!submission) {
    return <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Submission unavailable</div>
  }

  return (
    <TurtlePreviewPanel
      challenge={challenge}
      program={submission.block_program}
      trace={submission.trace}
      resultImageUrl={submission.result_image_url}
      title={title ?? `#${submission.id.slice(0, 8)}`}
      sourceLabel={sourceLabel ?? submission.status}
      className={className}
      viewportClassName={viewportClassName}
      animated={animated}
      animationKey={animationKey}
      showTarget={false}
      showTurtle={showTurtle}
    />
  )
}

function LeaderboardList({ leaderboard }: { leaderboard: LeaderboardEntry[] }) {
  if (leaderboard.length === 0) return <EmptyPanel title="No leaderboard" description="Scores appear after teams receive points." />

  return (
    <div className="grid gap-2">
      {leaderboard.slice(0, 12).map((team) => (
        <div key={team.team_id} className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="min-w-0">
            <div className="truncate font-medium">#{team.rank} {team.team_name}</div>
            <div className="text-sm text-muted-foreground">solved {team.solved_count}</div>
          </div>
          <div className="font-mono text-xl font-semibold tabular-nums">{team.total_score}</div>
        </div>
      ))}
    </div>
  )
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function PhaseBadge({ phase }: { phase: GamePhase }) {
  return <Badge variant={phase === "idle" ? "outline" : "secondary"}>{phaseLabel(phase)}</Badge>
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

function extendedDeadlineIso(snapshot: GameStateResponse, seconds: number) {
  const serverNow = Date.parse(snapshot.state.server_now)
  const currentDeadline = snapshot.state.phase_ends_at ? Date.parse(snapshot.state.phase_ends_at) : serverNow
  return new Date(Math.max(serverNow, currentDeadline) + seconds * 1_000).toISOString()
}

function nextPhase(phase: GamePhase): GamePhase | null {
  if (phase === "submission_open") return "team_selection"
  if (phase === "team_selection") return "public_voting"
  if (phase === "public_voting") return "round_complete"
  return null
}

function monitorDefaultTab(phase: GamePhase) {
  if (phase === "public_voting") return "votes"
  if (phase === "round_complete") return "results"
  return "nominations"
}

function phaseLabel(phase: GamePhase) {
  const labels: Record<GamePhase, string> = {
    idle: "Idle",
    submission_open: "Submission Open",
    team_selection: "Team Selection",
    public_voting: "Public Voting",
    scoring: "Scoring",
    round_complete: "Round Complete",
  }
  return labels[phase]
}

function positiveInteger(value: string, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function formatTimer(seconds: number | null) {
  if (seconds === null) return "--:--"
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

function formatTimerValue(deadline: string | null, serverNow: string) {
  if (!deadline) return "--:--"
  return formatTimer(Math.max(0, Math.ceil((Date.parse(deadline) - Date.parse(serverNow)) / 1_000)))
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value))
}

function sortSubmissionsByRecency(submissions: GameSubmission[]) {
  return [...submissions].sort((left, right) => compareSubmissionRecency(right, left))
}

function compareSubmissionRecency(left: GameSubmission, right: GameSubmission) {
  return (
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.attempt_no - right.attempt_no ||
    left.id.localeCompare(right.id)
  )
}

function submissionStatusLabel(submission: GameSubmission) {
  if (submission.status === "completed") return "completed"
  if (submission.status === "failed") return "failed"
  if (submission.status === "running") return "running"
  if (submission.status === "queued") return "queued"
  return submission.status
}

function formatSubmissionTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value))
}
