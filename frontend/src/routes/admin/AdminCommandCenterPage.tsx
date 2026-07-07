import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ClockIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  StepForwardIcon,
  TrophyIcon,
  XIcon,
} from "lucide-react"

import { ConfirmAction } from "@/components/admin/AdminPrimitives"
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
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { Challenge, Team } from "@/lib/admin/types"
import type {
  BlackboardDisplayMode,
  BlackboardPreviewSession,
  GamePhase,
  GameStateResponse,
  GameSubmission,
  LeaderboardEntry,
} from "@/lib/game/types"
import { cn } from "@/lib/utils"
import { useAdminRouteContext } from "@/routes/admin/admin-route-context"

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
  const { game, connectionState } = useAdminRouteContext()
  const [startForm, setStartForm] = useState<StartRoundForm>(defaultStartRoundForm)
  const [extendSeconds, setExtendSeconds] = useState("60")
  const [actionError, setActionError] = useState<string | null>(null)

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
      if (!snapshot) throw new Error("目前沒有進行中的遊戲狀態")
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

  const resetCurrentRound = useMutation({
    mutationFn: adminApi.resetCurrentRound,
    onSuccess: async (response) => {
      queryClient.setQueryData(["game", "state", "admin"], response)
      setActionError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["game", "state", "admin"] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
        queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "blackboard", "control"] }),
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
          <CardTitle>主持控制</CardTitle>
          <CardDescription>開始新回合、推進階段、延長時間並計分。</CardDescription>
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

      <Card>
        <CardHeader className="border-b">
          <CardTitle>危險操作</CardTitle>
          <CardDescription>重設會刪除目前回合的提交、投票、提名與回合計分，並清空黑板。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-semibold text-muted-foreground">
            {snapshot.state.phase === "idle" ? "目前沒有進行中的回合。" : "將遊戲重設為閒置狀態，讓主持人可以重新開始。"}
          </div>
          <ConfirmAction
            title="重設遊戲為閒置？"
            description="目前回合、提交、投票、提名與回合計分將被刪除，黑板會清空。此操作無法復原。"
            confirmLabel="重設為閒置"
            destructive
            disabled={snapshot.state.phase === "idle" || resetCurrentRound.isPending}
            onConfirm={async () => {
              await resetCurrentRound.mutateAsync()
            }}
          >
            <Button variant="destructive" disabled={snapshot.state.phase === "idle" || resetCurrentRound.isPending}>
              {resetCurrentRound.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
              重設為閒置
            </Button>
          </ConfirmAction>
        </CardContent>
      </Card>

      <BlackboardControlPanel
        snapshot={snapshot}
        teams={allTeams}
        mode={blackboardControl.data?.display.mode ?? blackboard.data?.display.mode ?? "submission"}
        blackboardSelectedSubmissionId={blackboardControl.data?.display.selected_submission_id ?? blackboard.data?.selected_submission_id ?? null}
        selectedPreviewRunId={blackboardControl.data?.display.selected_preview_run_id ?? blackboard.data?.display.selected_preview_run_id ?? null}
        previewSessions={blackboardControl.data?.preview_sessions ?? blackboard.data?.preview_sessions ?? []}
        teamNameById={teamNameById}
        isPending={setBlackboardDisplay.isPending}
        playingSubmissionId={playSubmission.variables ?? null}
        isPlayingSubmission={playSubmission.isPending}
        isClearingBlackboard={clearBlackboardPlayback.isPending}
        onPlaySubmission={(submissionId) => playSubmission.mutate(submissionId)}
        onClearBlackboard={() => clearBlackboardPlayback.mutate()}
        onSelectPreviewRun={(previewRunId) => setBlackboardDisplay.mutate({ mode: "preview", preview_run_id: previewRunId })}
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
              <CardTitle className="text-2xl">管理指揮中心</CardTitle>
              <PhaseBadge phase={snapshot.state.phase} />
              <Badge variant={connectionState === "open" ? "secondary" : "outline"}>
                {connectionState === "open" ? "即時" : "同步中"}
              </Badge>
            </div>
            <CardDescription className="truncate">
              {snapshot.challenge ? `${snapshot.challenge.title} / ${snapshot.challenge.description}` : "目前沒有進行中的回合"}
            </CardDescription>
          </div>
          <HeaderTimer snapshot={snapshot} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="回合" value={snapshot.round?.id.slice(0, 8) ?? "無"} />
        <StatTile label="隊伍" value={`${teams.filter((team) => team.enabled).length}/${teams.length}`} />
        <StatTile label="提交" value={snapshot.round_submissions.length} />
        <StatTile label="提名" value={snapshot.nominations.length} />
        <StatTile label="領先" value={leaderboard[0]?.team_name ?? "無"} />
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
        計時器
      </div>
      <div className="mt-2 font-mono text-3xl font-black tabular-nums">{formatTimer(seconds)}</div>
      <div className="mt-1 text-xs font-bold text-muted-foreground">伺服器 {formatClock(snapshot.state.server_now)}</div>
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
        <h2 className="font-black">開始回合</h2>
        <p className="text-sm font-semibold text-muted-foreground">使用目前挑戰題組中已啟用的題目。</p>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel>挑戰題目</FieldLabel>
          <Select
            items={challenges.map((challenge) => ({ value: challenge.id, label: challenge.title }))}
            value={form.challengeId}
            onValueChange={(value) => onChange({ ...form, challengeId: value ?? "" })}
          >
            <SelectTrigger className="w-full" aria-label="挑戰題目">
              <SelectValue placeholder="選擇挑戰題目" />
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
            <FieldLabel htmlFor="submission-seconds">提交時間（秒）</FieldLabel>
            <Input
              id="submission-seconds"
              inputMode="numeric"
              value={form.submissionSeconds}
              onChange={(event) => onChange({ ...form, submissionSeconds: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="public-votes-per-team">每隊公開投票票數</FieldLabel>
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
          {canStartRound ? "開始回合" : "回合進行中"}
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
        <h2 className="font-black">計時器</h2>
        <p className="text-sm font-semibold text-muted-foreground">目前階段的截止時間會從伺服器時間或原截止時間中較晚者往後延長。</p>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="extend-seconds">延長秒數</FieldLabel>
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
          延長計時
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
          推進階段
        </Button>
        <Button
          variant="outline"
          disabled={isScoring || snapshot.state.phase === "idle"}
          onClick={onScore}
        >
          {isScoring ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <TrophyIcon data-icon="inline-start" />}
          回合計分
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
          <div className="text-sm font-black text-muted-foreground">步驟 {index + 1}</div>
          <div className="font-black">{phaseLabel(item)}</div>
          <Badge className="mt-2" variant={index === currentIndex ? "secondary" : index < currentIndex ? "outline" : "outline"}>
            {index === currentIndex ? "目前" : index < currentIndex ? "完成" : "待處理"}
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
  blackboardSelectedSubmissionId,
  selectedPreviewRunId,
  previewSessions,
  teamNameById,
  isPending,
  playingSubmissionId,
  isPlayingSubmission,
  isClearingBlackboard,
  onPlaySubmission,
  onClearBlackboard,
  onSelectPreviewRun,
  onRefresh,
}: {
  snapshot: GameStateResponse
  teams: Team[]
  mode: BlackboardDisplayMode
  blackboardSelectedSubmissionId: string | null
  selectedPreviewRunId: string | null
  previewSessions: BlackboardPreviewSession[]
  teamNameById: Map<string, string>
  isPending: boolean
  playingSubmissionId: string | null
  isPlayingSubmission: boolean
  isClearingBlackboard: boolean
  onPlaySubmission: (submissionId: string) => void
  onClearBlackboard: () => void
  onSelectPreviewRun: (previewRunId: string) => void
  onRefresh: () => void
}) {
  const [activeTab, setActiveTab] = useState<BlackboardDisplayMode>(mode)
  const blackboardSubmission = blackboardSelectedSubmissionId
    ? snapshot.round_submissions.find((submission) => submission.id === blackboardSelectedSubmissionId) ?? null
    : null
  const selectedPreviewRun = selectedPreviewRunId
    ? previewSessions.flatMap((session) => session.runs).find((run) => run.id === selectedPreviewRunId) ?? null
    : null
  const blackboardOutputLabel = mode === "preview"
    ? selectedPreviewRun
      ? `${teamNameById.get(selectedPreviewRun.team_id) ?? selectedPreviewRun.team_id.slice(0, 8)} preview`
      : "預覽作品"
    : blackboardSubmission
      ? `${teamNameById.get(blackboardSubmission.team_id) ?? blackboardSubmission.team_id.slice(0, 8)} #${blackboardSubmission.attempt_no}`
      : "提交統計"
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>黑板控制</CardTitle>
            <CardDescription>選擇公開黑板上要顯示的內容。</CardDescription>
          </div>
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCwIcon data-icon="inline-start" />
            重新整理
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4">
        <div className="grid gap-3 rounded-[1rem] border-2 border-ink bg-surface-raised p-4 shadow-[3px_3px_0_rgba(23,35,58,0.12)] md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div className="min-w-0">
            <div className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">公開黑板顯示內容</div>
            <div className="mt-1 truncate text-xl font-black">{blackboardOutputLabel}</div>
            <div className="mt-1 text-sm font-semibold text-muted-foreground">
              {phaseLabel(snapshot.state.phase)} / {snapshot.challenge?.title ?? "目前沒有進行中的挑戰題目"} / {formatTimerValue(snapshot.state.phase_ends_at, snapshot.state.server_now)}
            </div>
          </div>
          <Badge variant={mode === "preview" ? "secondary" : "outline"} className="w-fit font-black">
            {mode === "preview" ? "預覽作品" : blackboardSubmission ? "提交重播" : "統計"}
          </Badge>
        </div>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            if (value === "submission" || value === "preview") {
              setActiveTab(value)
            }
          }}
        >
          <TabsList className="w-full flex-wrap justify-start">
            <TabsTrigger value="submission">
              <PlayIcon data-icon="inline-start" />
              提交作品
            </TabsTrigger>
            <TabsTrigger value="preview">
              <PlayIcon data-icon="inline-start" />
              預覽作品
            </TabsTrigger>
          </TabsList>
          <TabsContent value="submission" className="mt-4">
            <SubmissionReplayDeck
              snapshot={snapshot}
              teams={teams}
              mode={mode}
              teamNameById={teamNameById}
              blackboardSelectedSubmissionId={blackboardSelectedSubmissionId}
              playingSubmissionId={playingSubmissionId}
              isPlayingSubmission={isPlayingSubmission}
              isClearingBlackboard={isClearingBlackboard}
              onPlaySubmission={onPlaySubmission}
              onClearBlackboard={onClearBlackboard}
            />
          </TabsContent>
          <TabsContent value="preview" className="mt-4">
            <PreviewRunDeck
              snapshot={snapshot}
              mode={mode}
              previewSessions={previewSessions}
              teamNameById={teamNameById}
              selectedPreviewRunId={selectedPreviewRunId}
              isPending={isPending}
              onSelectPreviewRun={onSelectPreviewRun}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function PreviewRunDeck({
  snapshot,
  mode,
  previewSessions,
  teamNameById,
  selectedPreviewRunId,
  isPending,
  onSelectPreviewRun,
}: {
  snapshot: GameStateResponse
  mode: BlackboardDisplayMode
  previewSessions: BlackboardPreviewSession[]
  teamNameById: Map<string, string>
  selectedPreviewRunId: string | null
  isPending: boolean
  onSelectPreviewRun: (previewRunId: string) => void
}) {
  const [activePreviewTeamId, setActivePreviewTeamId] = useState<string | null>(null)
  const sessionsByTeam = useMemo(() => {
    const grouped = new Map<string, BlackboardPreviewSession[]>()
    for (const session of previewSessions) {
      const sessions = grouped.get(session.team_id) ?? []
      sessions.push(session)
      grouped.set(session.team_id, sessions)
    }
    return [...grouped.entries()].sort((left, right) => {
      const leftName = teamNameById.get(left[0]) ?? left[0]
      const rightName = teamNameById.get(right[0]) ?? right[0]
      return leftName.localeCompare(rightName)
    })
  }, [previewSessions, teamNameById])
  const firstTeamId = sessionsByTeam[0]?.[0] ?? null
  const selectedTeamId = sessionsByTeam.some(([teamId]) => teamId === activePreviewTeamId)
    ? activePreviewTeamId
    : firstTeamId

  if (sessionsByTeam.length === 0) {
    return (
      <EmptyPanel
        title="尚未有預覽作品"
        description="學生按下預覽後，每個工作站最新 5 筆預覽會出現在這裡。"
      />
    )
  }

  return (
    <Tabs
      value={selectedTeamId ?? undefined}
      onValueChange={setActivePreviewTeamId}
      orientation="vertical"
      className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]"
    >
      <TabsList className="w-full">
        {sessionsByTeam.map(([teamId, sessions]) => {
          const runCount = sessions.reduce((total, session) => total + session.runs.length, 0)
          return (
            <TabsTrigger key={teamId} value={teamId} className="justify-start">
              {teamNameById.get(teamId) ?? teamId.slice(0, 8)}
              <Badge variant="outline" className="ml-auto">{runCount}</Badge>
            </TabsTrigger>
          )
        })}
      </TabsList>
      {sessionsByTeam.map(([teamId, sessions]) => (
        <TabsContent key={teamId} value={teamId} className="min-w-0">
          <div className="min-w-0 overflow-x-auto pb-2">
            <div className="flex min-w-max gap-4">
              {sessions.map((session) => (
                <PreviewSessionLane
                  key={session.session_id}
                  session={session}
                  challenge={snapshot.challenge}
                  teamName={teamNameById.get(session.team_id) ?? session.team_id.slice(0, 8)}
                  selectedPreviewRunId={selectedPreviewRunId}
                  onBoard={mode === "preview"}
                  isPending={isPending}
                  onSelectPreviewRun={onSelectPreviewRun}
                />
              ))}
            </div>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  )
}

function PreviewSessionLane({
  session,
  challenge,
  teamName,
  selectedPreviewRunId,
  onBoard,
  isPending,
  onSelectPreviewRun,
}: {
  session: BlackboardPreviewSession
  challenge: GameStateResponse["challenge"]
  teamName: string
  selectedPreviewRunId: string | null
  onBoard: boolean
  isPending: boolean
  onSelectPreviewRun: (previewRunId: string) => void
}) {
  const [localRunId, setLocalRunId] = useState<string | null>(null)
  const boardRun = selectedPreviewRunId
    ? session.runs.find((run) => run.id === selectedPreviewRunId) ?? null
    : null
  const localRun = localRunId ? session.runs.find((run) => run.id === localRunId) ?? null : null
  const selectedRun = localRun ?? boardRun ?? session.runs[0] ?? null
  const isSelectedOnBoard = Boolean(selectedRun && onBoard && selectedRun.id === selectedPreviewRunId)

  return (
    <article className={cn(
      "grid w-[24rem] shrink-0 gap-3 rounded-[1rem] border-2 bg-card p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]",
      isSelectedOnBoard ? "border-primary" : "border-ink",
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-black">{teamName}</div>
          <div className="text-sm font-semibold text-muted-foreground">{session.label}</div>
        </div>
        <Badge variant={isSelectedOnBoard ? "secondary" : "outline"} className="font-black">
          {isSelectedOnBoard ? "黑板顯示中" : `${session.runs.length} 筆`}
        </Badge>
      </div>
      <TurtlePreviewPanel
        challenge={challenge}
        program={selectedRun?.block_program ?? null}
        title="預覽畫面"
        sourceLabel={selectedRun ? formatSubmissionTime(selectedRun.created_at) : "empty"}
        className="h-64"
        viewportClassName="h-[calc(100%-4.5rem)]"
        animated
        animationKey={selectedRun?.id ?? session.session_id}
        showTarget={false}
        showTurtle
      />
      <div className="min-w-0 overflow-x-auto pb-1">
        <div className="flex gap-2">
          {session.runs.map((run, index) => (
            <button
              key={run.id}
              type="button"
              onClick={() => setLocalRunId(run.id)}
              className={cn(
                "min-w-24 rounded-[0.875rem] border px-3 py-2 text-left text-xs font-black shadow-[1px_1px_0_rgba(23,35,58,0.08)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedRun?.id === run.id ? "border-primary bg-primary/10" : "border-border bg-background/80 hover:bg-surface-raised",
              )}
            >
              <div className="font-mono">#{index + 1}</div>
              <div className="mt-1 truncate text-muted-foreground">{formatSubmissionTime(run.created_at)}</div>
            </button>
          ))}
        </div>
      </div>
      <Button
        disabled={!selectedRun || isPending}
        onClick={() => selectedRun ? onSelectPreviewRun(selectedRun.id) : undefined}
      >
        {isPending && isSelectedOnBoard ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <PlayIcon data-icon="inline-start" />}
        {isSelectedOnBoard ? "正在黑板上" : "送到黑板"}
      </Button>
    </article>
  )
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
            <CardTitle>即時回合監控</CardTitle>
            <CardDescription>檢視提名、公開投票、結果與排行榜資訊。</CardDescription>
          </div>
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCwIcon data-icon="inline-start" />
            重新整理
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <Tabs key={defaultTab} defaultValue={defaultTab}>
          <TabsList className="w-full flex-wrap justify-start">
            <TabsTrigger value="nominations">提名</TabsTrigger>
            <TabsTrigger value="votes">票數</TabsTrigger>
            <TabsTrigger value="results">結果</TabsTrigger>
            <TabsTrigger value="leaderboard">排行榜</TabsTrigger>
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
  blackboardSelectedSubmissionId,
  playingSubmissionId,
  isPlayingSubmission,
  isClearingBlackboard,
  onPlaySubmission,
  onClearBlackboard,
}: {
  snapshot: GameStateResponse
  teams: Team[]
  mode: BlackboardDisplayMode
  teamNameById: Map<string, string>
  blackboardSelectedSubmissionId: string | null
  playingSubmissionId: string | null
  isPlayingSubmission: boolean
  isClearingBlackboard: boolean
  onPlaySubmission: (submissionId: string) => void
  onClearBlackboard: () => void
}) {
  const [activeSubmissionTeamId, setActiveSubmissionTeamId] = useState<string | null>(null)
  const submissions = useMemo(() => sortSubmissionsByRecency(snapshot.round_submissions), [snapshot.round_submissions])
  const blackboardSubmission = blackboardSelectedSubmissionId
    ? submissions.find((submission) => submission.id === blackboardSelectedSubmissionId) ?? null
    : null
  const submissionsByTeam = useMemo(() => {
    const grouped = new Map<string, GameSubmission[]>()
    for (const submission of submissions) {
      const teamSubmissions = grouped.get(submission.team_id) ?? []
      teamSubmissions.push(submission)
      grouped.set(submission.team_id, teamSubmissions)
    }
    return [...grouped.entries()].sort((left, right) => {
      const leftName = teamNameById.get(left[0]) ?? left[0]
      const rightName = teamNameById.get(right[0]) ?? right[0]
      return leftName.localeCompare(rightName)
    })
  }, [submissions, teamNameById])
  const completedCount = submissions.filter(canPlaySubmission).length
  const activeTeamCount = new Set(submissions.map((submission) => submission.team_id)).size
  const enabledTeamCount = teams.filter((team) => team.enabled).length
  const firstTeamId = submissionsByTeam[0]?.[0] ?? null
  const boardTeamId = blackboardSubmission?.team_id ?? null
  const defaultTeamId = boardTeamId && submissionsByTeam.some(([teamId]) => teamId === boardTeamId) ? boardTeamId : firstTeamId
  const selectedTeamId = submissionsByTeam.some(([teamId]) => teamId === activeSubmissionTeamId)
    ? activeSubmissionTeamId
    : defaultTeamId

  if (submissions.length === 0) {
    return (
      <EmptyPanel
        title="尚未有提交作品"
        description="隊伍提交繪圖後，作品會依小隊分組出現在這裡。"
      />
    )
  }

  const canClearToCounts = mode !== "submission" || Boolean(blackboardSelectedSubmissionId)

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="font-black">{submissions.length} 總數</Badge>
          <Badge variant="outline" className="font-black">{completedCount} 可播放</Badge>
          <Badge variant="outline" className="font-black">{activeTeamCount}/{enabledTeamCount} 隊伍</Badge>
        </div>
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
          清除並顯示統計
        </Button>
      </div>
      <Tabs
        value={selectedTeamId ?? undefined}
        onValueChange={setActiveSubmissionTeamId}
        orientation="vertical"
        className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]"
      >
        <TabsList className="w-full">
          {submissionsByTeam.map(([teamId, teamSubmissions]) => (
            <TabsTrigger key={teamId} value={teamId} className="justify-start">
              {teamNameById.get(teamId) ?? teamId.slice(0, 8)}
              <Badge variant="outline" className="ml-auto">{teamSubmissions.length}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
        {submissionsByTeam.map(([teamId, teamSubmissions]) => (
          <TabsContent key={teamId} value={teamId} className="min-w-0">
            <div className="min-w-0 overflow-x-auto pb-2">
              <div className="flex min-w-max gap-4">
                <SubmissionTeamLane
                  submissions={teamSubmissions}
                  challenge={snapshot.challenge}
                  teamName={teamNameById.get(teamId) ?? teamId.slice(0, 8)}
                  blackboardSelectedSubmissionId={blackboardSelectedSubmissionId}
                  onBoard={mode === "submission"}
                  playingSubmissionId={playingSubmissionId}
                  isPlayingSubmission={isPlayingSubmission}
                  onPlaySubmission={onPlaySubmission}
                />
              </div>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function SubmissionTeamLane({
  submissions,
  challenge,
  teamName,
  blackboardSelectedSubmissionId,
  onBoard,
  playingSubmissionId,
  isPlayingSubmission,
  onPlaySubmission,
}: {
  submissions: GameSubmission[]
  challenge: GameStateResponse["challenge"]
  teamName: string
  blackboardSelectedSubmissionId: string | null
  onBoard: boolean
  playingSubmissionId: string | null
  isPlayingSubmission: boolean
  onPlaySubmission: (submissionId: string) => void
}) {
  const [localSubmissionId, setLocalSubmissionId] = useState<string | null>(null)
  const boardSubmission = blackboardSelectedSubmissionId
    ? submissions.find((submission) => submission.id === blackboardSelectedSubmissionId) ?? null
    : null
  const localSubmission = localSubmissionId
    ? submissions.find((submission) => submission.id === localSubmissionId) ?? null
    : null
  const latestPlayableSubmission = submissions.find(canPlaySubmission) ?? null
  const selectedSubmission = localSubmission ?? boardSubmission ?? latestPlayableSubmission ?? submissions[0] ?? null
  const selectedCanPlay = selectedSubmission ? canPlaySubmission(selectedSubmission) : false
  const isSelectedOnBoard = Boolean(selectedSubmission && onBoard && selectedSubmission.id === blackboardSelectedSubmissionId)
  const playableCount = submissions.filter(canPlaySubmission).length

  return (
    <article className={cn(
      "grid w-[24rem] shrink-0 gap-3 rounded-[1rem] border-2 bg-card p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]",
      isSelectedOnBoard ? "border-primary" : "border-ink",
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-black">{teamName}</div>
          <div className="text-sm font-semibold text-muted-foreground">{playableCount}/{submissions.length} 可播放</div>
        </div>
        <Badge variant={isSelectedOnBoard ? "secondary" : "outline"} className="font-black">
          {isSelectedOnBoard ? "黑板顯示中" : `${submissions.length} 筆`}
        </Badge>
      </div>
      {selectedSubmission ? (
        <SubmissionPreview
          submission={selectedSubmission}
          challenge={challenge}
          title="提交畫面"
          sourceLabel={`${submissionStatusLabel(selectedSubmission)} / ${formatSubmissionTime(selectedSubmission.created_at)}`}
          className="h-64"
          viewportClassName="h-[calc(100%-4.5rem)]"
          animated={selectedCanPlay}
          animationKey={`admin-submission:${selectedSubmission.id}`}
          showTurtle={selectedCanPlay}
        />
      ) : (
        <EmptyPanel title="尚未有提交作品" description="這個小隊還沒有提交繪圖。" />
      )}
      <div className="min-w-0 overflow-x-auto pb-1">
        <div className="flex gap-2">
          {submissions.map((submission) => (
            <button
              key={submission.id}
              type="button"
              onClick={() => setLocalSubmissionId(submission.id)}
              className={cn(
                "min-w-28 rounded-[0.875rem] border px-3 py-2 text-left text-xs font-black shadow-[1px_1px_0_rgba(23,35,58,0.08)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedSubmission?.id === submission.id ? "border-primary bg-primary/10" : "border-border bg-background/80 hover:bg-surface-raised",
              )}
            >
              <div className="font-mono">#{submission.attempt_no}</div>
              <div className="mt-1 truncate text-muted-foreground">{formatSubmissionTime(submission.created_at)}</div>
              <div className="mt-1 truncate text-muted-foreground">{submissionStatusLabel(submission)}</div>
            </button>
          ))}
        </div>
      </div>
      <Button
        disabled={!selectedSubmission || !selectedCanPlay || isPlayingSubmission}
        onClick={() => selectedSubmission ? onPlaySubmission(selectedSubmission.id) : undefined}
      >
        {isPlayingSubmission && playingSubmissionId === selectedSubmission?.id ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <PlayIcon data-icon="inline-start" />
        )}
        {isSelectedOnBoard ? "正在黑板上" : "播放至黑板"}
      </Button>
    </article>
  )
}

function NominationGrid({ snapshot, teamNameById }: { snapshot: GameStateResponse; teamNameById: Map<string, string> }) {
  const submissionsById = new Map(snapshot.round_submissions.map((submission) => [submission.id, submission]))

  if (snapshot.nominations.length === 0) return <EmptyPanel title="尚未有提名" description="各隊選出代表作品後，提名會顯示在這裡。" />

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {snapshot.nominations.map((nomination) => {
        const submission = submissionsById.get(nomination.submission_id)
        return (
          <div key={nomination.team_id} className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="truncate font-medium">{teamNameById.get(nomination.team_id) ?? nomination.team_id.slice(0, 8)}</div>
              <Badge variant="outline">{nomination.vote_count} 張隊伍票</Badge>
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

  if (nominations.length === 0) return <EmptyPanel title="尚未有公開投票目標" description="進入公開投票時，代表繪圖會顯示在這裡。" />

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {nominations.map(({ nomination, submission, votes }) => (
        <div key={nomination.team_id} className="grid gap-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate font-medium">{teamNameById.get(nomination.team_id) ?? nomination.team_id.slice(0, 8)}</div>
            <Badge variant="secondary">{votes} 票</Badge>
          </div>
          <SubmissionPreview submission={submission} />
        </div>
      ))}
    </div>
  )
}

function ResultGrid({ snapshot, teamNameById }: { snapshot: GameStateResponse; teamNameById: Map<string, string> }) {
  const submissionsById = new Map(snapshot.round_submissions.map((submission) => [submission.id, submission]))

  if (snapshot.results.length === 0) return <EmptyPanel title="尚未有結果" description="回合計分後，結果會顯示在這裡。" />

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
    return <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">提交作品無法使用</div>
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
  if (leaderboard.length === 0) return <EmptyPanel title="尚未有排行榜" description="隊伍獲得分數後，分數會顯示在這裡。" />

  return (
    <div className="grid gap-2">
      {leaderboard.slice(0, 12).map((team) => (
        <div key={team.team_id} className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="min-w-0">
            <div className="truncate font-medium">#{team.rank} {team.team_name}</div>
            <div className="text-sm text-muted-foreground">完成題數 {team.solved_count}</div>
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
    idle: "閒置",
    submission_open: "開放提交",
    team_selection: "隊內選拔",
    public_voting: "公開投票",
    scoring: "計分中",
    round_complete: "回合完成",
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

function canPlaySubmission(submission: GameSubmission) {
  return submission.status === "completed" && Boolean(submission.trace)
}

function submissionStatusLabel(submission: GameSubmission) {
  if (submission.status === "completed") return "已完成"
  if (submission.status === "failed") return "失敗"
  if (submission.status === "running") return "執行中"
  if (submission.status === "queued") return "排隊中"
  return submission.status
}

function formatSubmissionTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value))
}
