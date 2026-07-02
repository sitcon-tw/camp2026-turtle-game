import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ClockIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  StepForwardIcon,
  TrophyIcon,
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
import { useGameEvents } from "@/hooks/use-game-events"
import { adminApi, errorMessage } from "@/lib/admin/api"
import { getAdminToken } from "@/lib/admin/session"
import type { Challenge, Team } from "@/lib/admin/types"
import type { GamePhase, GameStateResponse, GameSubmission, LeaderboardEntry } from "@/lib/game/types"

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

  const connectionState = useGameEvents({
    token,
    onSnapshot: (snapshot) => queryClient.setQueryData(["game", "state", "admin"], snapshot),
    onError: () => undefined,
  })

  const snapshot = game.data
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

      <LiveRoundMonitor
        snapshot={snapshot}
        teams={allTeams}
        leaderboard={leaderboardTeams}
        teamNameById={teamNameById}
        onRefresh={() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] }),
            queryClient.invalidateQueries({ queryKey: ["admin", "teams"] }),
            queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
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
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ClockIcon className="size-4" />
        Timer
      </div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums">{formatTimer(seconds)}</div>
      <div className="mt-1 text-xs text-muted-foreground">server {formatClock(snapshot.state.server_now)}</div>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold">{value}</div>
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
    <div className="rounded-md border p-4">
      <div className="mb-4">
        <h2 className="font-semibold">Start Round</h2>
        <p className="text-sm text-muted-foreground">Uses enabled challenges from the active challenge set.</p>
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
    <div className="rounded-md border p-4">
      <div className="mb-4">
        <h2 className="font-semibold">Timer</h2>
        <p className="text-sm text-muted-foreground">Current phase deadline is extended from the later of server time or deadline.</p>
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
        <div key={item} className="rounded-md border bg-muted/30 p-3">
          <div className="text-sm text-muted-foreground">Step {index + 1}</div>
          <div className="font-medium">{phaseLabel(item)}</div>
          <Badge className="mt-2" variant={index === currentIndex ? "secondary" : index < currentIndex ? "outline" : "outline"}>
            {index === currentIndex ? "Current" : index < currentIndex ? "Done" : "Pending"}
          </Badge>
        </div>
      ))}
    </div>
  )
}

function LiveRoundMonitor({
  snapshot,
  teams,
  leaderboard,
  teamNameById,
  onRefresh,
}: {
  snapshot: GameStateResponse
  teams: Team[]
  leaderboard: LeaderboardEntry[]
  teamNameById: Map<string, string>
  onRefresh: () => void
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Live Round Monitor</CardTitle>
            <CardDescription>Round submissions, nominations, public votes, and results.</CardDescription>
          </div>
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <Tabs defaultValue="submissions">
          <TabsList className="w-full flex-wrap justify-start">
            <TabsTrigger value="submissions">Submissions</TabsTrigger>
            <TabsTrigger value="nominations">Nominations</TabsTrigger>
            <TabsTrigger value="votes">Votes</TabsTrigger>
            <TabsTrigger value="results">Results</TabsTrigger>
            <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
          </TabsList>
          <TabsContent value="submissions" className="mt-4">
            <SubmissionMatrix snapshot={snapshot} teams={teams} teamNameById={teamNameById} />
          </TabsContent>
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

function SubmissionMatrix({
  snapshot,
  teams,
  teamNameById,
}: {
  snapshot: GameStateResponse
  teams: Team[]
  teamNameById: Map<string, string>
}) {
  const counts = countSubmissionsByTeam(snapshot.round_submissions)

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {teams.filter((team) => team.enabled).map((team) => (
        <div key={team.id} className="rounded-md border p-3">
          <div className="truncate font-medium">{teamNameById.get(team.id) ?? team.name}</div>
          <div className="mt-2 font-mono text-3xl font-semibold tabular-nums">{counts.get(team.id) ?? 0}</div>
          <div className="text-sm text-muted-foreground">submitted drawings</div>
        </div>
      ))}
    </div>
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

function SubmissionPreview({ submission }: { submission?: GameSubmission }) {
  if (!submission) {
    return <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Submission unavailable</div>
  }

  return (
    <TurtlePreviewPanel
      program={submission.block_program}
      trace={submission.trace}
      resultImageUrl={submission.result_image_url}
      title={`#${submission.id.slice(0, 8)}`}
      sourceLabel={submission.status}
      className="h-64"
      viewportClassName="h-[calc(100%-4.5rem)]"
      showTarget={false}
      showTurtle={false}
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

function countSubmissionsByTeam(submissions: GameSubmission[]) {
  const counts = new Map<string, number>()
  for (const submission of submissions) counts.set(submission.team_id, (counts.get(submission.team_id) ?? 0) + 1)
  return counts
}

function nextPhase(phase: GamePhase): GamePhase | null {
  if (phase === "submission_open") return "team_selection"
  if (phase === "team_selection") return "public_voting"
  if (phase === "public_voting") return "round_complete"
  return null
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

function formatClock(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value))
}
