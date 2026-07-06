import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { Workspace } from "blockly/core"
import { BlocklyWorkspace } from "react-blockly"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CheckIcon,
  ClockIcon,
  Loader2Icon,
  PlayIcon,
  SendIcon,
  VoteIcon,
} from "lucide-react"

import { TurtlePreviewPanel } from "@/components/turtle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useGameEvents } from "@/hooks/use-game-events"
import { reactBlocklyToolboxCategories, registerTurtleBlocks, workspaceToBackendProgram } from "@/lib/blockly"
import type { ChallengeCanvas } from "@/lib/blockly"
import type { GameChallenge, GamePhase, GameStateResponse, GameSubmission, LeaderboardEntry, PublicVoteChoice } from "@/lib/game/types"
import { studentApi, studentErrorMessage } from "@/lib/student/api"
import { getTeamDeviceId, getTeamToken } from "@/lib/student/session"
import type { Team } from "@/lib/student/types"

registerTurtleBlocks()

const EMPTY_WORKSPACE_XML = '<xml xmlns="https://developers.google.com/blockly/xml"></xml>'

type BlocklyToolboxApi = {
  setVisible: (isVisible: boolean) => void
  autoHide?: (onlyClosePopups?: boolean) => void
  clearSelection?: () => void
  getSelectedItem?: () => unknown
  getToolboxItems?: () => unknown[]
  setSelectedItem?: (item: unknown) => void
  __rtkKeepOpen?: boolean
  __rtkLastSelectedItem?: unknown
}

type BlocklyWorkspaceSvgApi = {
  getToolbox: () => BlocklyToolboxApi | null
}

type LocalPreviewState = {
  roundId: string | null
  program: unknown | null
  animationKey: number
}

type PreviewGateState = {
  roundId: string | null
  hasPreviewed: boolean
}

export default function TeamStationPage() {
  const queryClient = useQueryClient()
  const token = getTeamToken()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [localPreview, setLocalPreview] = useState<LocalPreviewState>({
    roundId: null,
    program: null,
    animationKey: 0,
  })
  const [previewGate, setPreviewGate] = useState<PreviewGateState>({
    roundId: null,
    hasPreviewed: false,
  })
  const [publicVoteDraft, setPublicVoteDraft] = useState<{ roundId: string | null; choices: PublicVoteChoice[] }>({
    roundId: null,
    choices: [],
  })
  const [actionError, setActionError] = useState<string | null>(null)

  const game = useQuery({
    queryKey: ["game", "state", "team"],
    queryFn: studentApi.gameState,
    refetchInterval: 10_000,
  })
  const me = useQuery({
    queryKey: ["student", "me"],
    queryFn: studentApi.me,
    retry: false,
  })
  const leaderboard = useQuery({
    queryKey: ["leaderboard"],
    queryFn: studentApi.leaderboard,
    refetchInterval: 10_000,
  })

  const connectionState = useGameEvents({
    token,
    onSnapshot: (snapshot) => {
      queryClient.setQueryData(["game", "state", "team"], snapshot)
    },
    onError: () => undefined,
  })

  const snapshot = game.data
  const remainingSeconds = useRemainingSeconds(snapshot)
  const myTeam = me.data ?? null
  const leaderboardTeams = useMemo(() => leaderboard.data?.teams ?? [], [leaderboard.data?.teams])
  const teamNameById = useMemo(
    () => new Map(leaderboardTeams.map((team) => [team.team_id, team.team_name])),
    [leaderboardTeams],
  )
  const mySubmissions = useMemo(() => sortSubmissions(snapshot?.my_submissions ?? []), [snapshot?.my_submissions])
  const selectedSubmissionId = snapshot?.my_team_selection_vote?.submission_id ?? null
  const publicVoteLimit = snapshot?.state.public_votes_per_team ?? 0
  const currentRoundId = snapshot?.state.current_round_id ?? null
  const localPreviewProgram = localPreview.roundId === currentRoundId ? localPreview.program : null
  const hasPreviewedForCurrentRound = previewGate.roundId === currentRoundId && previewGate.hasPreviewed
  const submissionWindowOpen = remainingSeconds === null || remainingSeconds > 0
  const activePublicVoteDraft =
    publicVoteDraft.roundId === currentRoundId && publicVoteDraft.choices.length > 0
      ? publicVoteDraft.choices
      : snapshot?.my_public_vote?.choices ?? []

  const submitDrawing = useMutation({
    mutationFn: async () => {
      if (!workspace || !snapshot?.challenge) throw new Error("工作區尚未準備好")
      if (!hasPreviewedForCurrentRound) throw new Error("請先預覽作品，再提交。")
      const program = workspaceToBackendProgram(workspace, { canvas: snapshot.challenge.canvas as ChallengeCanvas })
      const response = await studentApi.createCurrentRoundSubmission(program)
      return { roundId: currentRoundId, response }
    },
    onSuccess: async ({ roundId }) => {
      setPreviewGate({
        roundId,
        hasPreviewed: false,
      })
      setLocalPreview((preview) => ({
        ...preview,
        animationKey: preview.animationKey + 1,
      }))
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ["game", "state", "team"] })
    },
    onError: (error) => setActionError(studentErrorMessage(error)),
  })

  const selectRepresentative = useMutation({
    mutationFn: (submissionId: string) => studentApi.recordTeamSelectionVote(submissionId, getTeamDeviceId()),
    onSuccess: async () => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ["game", "state", "team"] })
    },
    onError: (error) => setActionError(studentErrorMessage(error)),
  })

  const submitPublicVote = useMutation({
    mutationFn: (votes: PublicVoteChoice[]) => studentApi.recordPublicVote(votes),
    onSuccess: async () => {
      setActionError(null)
      await queryClient.invalidateQueries({ queryKey: ["game", "state", "team"] })
    },
    onError: (error) => setActionError(studentErrorMessage(error)),
  })

  function previewWorkspaceProgram() {
    if (!workspace || !snapshot?.challenge) return

    try {
      const program = workspaceToBackendProgram(workspace, { canvas: snapshot.challenge.canvas as ChallengeCanvas })
      setLocalPreview((preview) => ({
        roundId: currentRoundId,
        program,
        animationKey: preview.animationKey + 1,
      }))
      setPreviewGate({
        roundId: currentRoundId,
        hasPreviewed: true,
      })
      setActionError(null)
    } catch (error) {
      setActionError(studentErrorMessage(error))
    }
  }

  function handleWorkspaceInject(newWorkspace: unknown) {
    setWorkspace(newWorkspace as Workspace)
    keepBlocklyToolboxOpen(newWorkspace)
  }

  function togglePublicVote(submission: GameSubmission) {
    if (!snapshot || !myTeam || submission.team_id === myTeam.id) return

    setPublicVoteDraft((current) => {
      const base =
        current.roundId === snapshot.state.current_round_id && current.choices.length > 0
          ? current.choices
          : snapshot.my_public_vote?.choices ?? []
      if (base.some((vote) => vote.target_submission_id === submission.id)) {
        return {
          roundId: snapshot.state.current_round_id,
          choices: normalizeVoteRanks(base.filter((vote) => vote.target_submission_id !== submission.id)),
        }
      }
      if (base.length >= publicVoteLimit) return { roundId: snapshot.state.current_round_id, choices: base }
      return {
        roundId: snapshot.state.current_round_id,
        choices: normalizeVoteRanks([
          ...base,
          {
            target_team_id: submission.team_id,
            target_submission_id: submission.id,
            rank: base.length + 1,
          },
        ]),
      }
    })
  }

  if (game.isLoading) {
    return (
      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-4 sm:px-6">
        <Skeleton className="h-32" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <Skeleton className="h-[560px]" />
          <Skeleton className="h-[560px]" />
        </div>
      </div>
    )
  }

  if (game.isError || !snapshot) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Card>
          <CardContent className="pt-6">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>無法載入小隊工作站</EmptyTitle>
                <EmptyDescription>{game.isError ? studentErrorMessage(game.error) : "目前沒有遊戲資料。"}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6">
      <RoundHeader
        snapshot={snapshot}
        team={myTeam}
        connectionState={connectionState}
        submissionCount={mySubmissions.length}
        selectedSubmissionId={selectedSubmissionId}
      />

      {actionError ? (
        <Card>
          <CardContent className="py-3 text-sm text-destructive">{actionError}</CardContent>
        </Card>
      ) : null}

      {snapshot.state.phase === "submission_open" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
          <Card className="overflow-hidden">
            <CardHeader className="border-b">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>作畫工作區</CardTitle>
                  <CardDescription>{snapshot.challenge?.title ?? "目前回合"}</CardDescription>
                </div>
                <WorkspaceTimer snapshot={snapshot} />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="h-[min(64vh,680px)] min-h-[520px]">
                <BlocklyWorkspace
                  toolboxConfiguration={reactBlocklyToolboxCategories}
                  initialXml={EMPTY_WORKSPACE_XML}
                  workspaceConfiguration={blocklyWorkspaceConfiguration}
                  onInject={handleWorkspaceInject}
                  className="h-full w-full"
                />
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4">
            <ChallengeImagePanel challenge={snapshot.challenge} />
            <PreviewPanel
              title="預覽"
              program={localPreviewProgram}
              animationKey={`${currentRoundId ?? "no-round"}:${localPreview.animationKey}`}
              canPreview={Boolean(workspace && snapshot.challenge)}
              canSubmit={Boolean(
                workspace &&
                  snapshot.challenge &&
                  hasPreviewedForCurrentRound &&
                  submissionWindowOpen &&
                  !submitDrawing.isPending,
              )}
              isSubmitting={submitDrawing.isPending}
              onPreview={previewWorkspaceProgram}
              onSubmit={() => submitDrawing.mutate()}
            />
            <MySubmissionList submissions={mySubmissions} selectedSubmissionId={selectedSubmissionId} />
          </div>
        </div>
      ) : null}

      {snapshot.state.phase === "team_selection" ? (
        <TeamSelectionPanel
          submissions={mySubmissions}
          selectedSubmissionId={selectedSubmissionId}
          isSaving={selectRepresentative.isPending}
          onSelect={(submissionId) => selectRepresentative.mutate(submissionId)}
        />
      ) : null}

      {snapshot.state.phase === "public_voting" ? (
        <PublicVotingPanel
          snapshot={snapshot}
          myTeamId={myTeam?.id ?? null}
          teamNameById={teamNameById}
          draft={activePublicVoteDraft}
          isSaving={submitPublicVote.isPending}
          onToggle={togglePublicVote}
          onSubmit={() => submitPublicVote.mutate(activePublicVoteDraft)}
        />
      ) : null}

      {snapshot.state.phase === "round_complete" || snapshot.state.phase === "scoring" ? (
        <ResultsPanel snapshot={snapshot} leaderboard={leaderboardTeams} teamNameById={teamNameById} />
      ) : null}

      {snapshot.state.phase === "idle" ? <IdlePanel /> : null}
    </div>
  )
}

function RoundHeader({
  snapshot,
  team,
  connectionState,
  submissionCount,
  selectedSubmissionId,
}: {
  snapshot: GameStateResponse
  team: Team | null
  connectionState: string
  submissionCount: number
  selectedSubmissionId: string | null
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <CardTitle className="text-2xl">Team Station</CardTitle>
              <PhaseBadge phase={snapshot.state.phase} />
              <Badge variant={connectionState === "open" ? "secondary" : "outline"}>
                {connectionState === "open" ? "Live" : "Sync"}
              </Badge>
            </div>
            <CardDescription className="truncate">
              {snapshot.challenge ? `${snapshot.challenge.title} / ${snapshot.challenge.description}` : "等待主持人開始回合"}
            </CardDescription>
          </div>
          <TimerCard snapshot={snapshot} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="我的隊伍" value={team?.name ?? "隊伍"} />
        <StatTile label="目前總分" value={team?.total_score ?? 0} />
        <StatTile label="本回合提交" value={submissionCount} />
        <StatTile label="代表作品" value={selectedSubmissionId ? `#${selectedSubmissionId.slice(0, 6)}` : "未選"} />
      </CardContent>
    </Card>
  )
}

function TimerCard({ snapshot }: { snapshot: GameStateResponse }) {
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

function WorkspaceTimer({ snapshot }: { snapshot: GameStateResponse }) {
  const seconds = useRemainingSeconds(snapshot)

  return (
    <div className="inline-flex shrink-0 items-center gap-2 self-start rounded-full border-2 border-ink bg-surface-raised px-3 py-1.5 shadow-[2px_2px_0_rgba(23,35,58,0.14)]">
      <ClockIcon className="size-4 text-muted-foreground" />
      <span className="font-mono text-sm font-black tabular-nums">{formatTimer(seconds)}</span>
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

function ChallengeImagePanel({ challenge }: { challenge: GameChallenge | null }) {
  if (!challenge) return null

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>題目</CardTitle>
        <CardDescription>{challenge.title}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <TurtlePreviewPanel
          challenge={challenge}
          title="目標圖"
          sourceLabel={challenge.description}
          className="h-64"
          viewportClassName="h-[calc(100%-4.5rem)]"
          showTarget
          showTurtle={false}
          footerStart={`${challenge.canvas.width} x ${challenge.canvas.height}`}
          footerEnd={`${challenge.points} 分`}
        />
      </CardContent>
    </Card>
  )
}

function PreviewPanel({
  title,
  program,
  animationKey,
  canPreview,
  canSubmit,
  isSubmitting,
  onPreview,
  onSubmit,
}: {
  title: string
  program: unknown | null
  animationKey: string
  canPreview: boolean
  canSubmit: boolean
  isSubmitting: boolean
  onPreview: () => void
  onSubmit: () => void
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>本地預覽畫面，不會使用提交紀錄</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onPreview} disabled={!canPreview}>
              <PlayIcon data-icon="inline-start" />
              預覽
            </Button>
            <Button onClick={onSubmit} disabled={!canSubmit}>
              {isSubmitting ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <SendIcon data-icon="inline-start" />
              )}
              提交
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <TurtlePreviewPanel
          program={program}
          title="本地 Canvas"
          sourceLabel={program ? "local preview" : "empty"}
          className="h-80"
          viewportClassName="h-[calc(100%-4.5rem)]"
          animated
          animationKey={animationKey}
          showTarget={false}
          showTurtle
        />
      </CardContent>
    </Card>
  )
}

function MySubmissionList({
  submissions,
  selectedSubmissionId,
}: {
  submissions: GameSubmission[]
  selectedSubmissionId: string | null
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>提交紀錄</CardTitle>
        <CardDescription>{submissions.length} 件本回合作品</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 pt-4">
        {submissions.length === 0 ? (
          <p className="rounded-[1rem] border-2 border-dashed border-border bg-surface-raised/70 p-4 text-sm font-semibold text-muted-foreground">尚未提交。</p>
        ) : (
          submissions.slice(0, 5).map((submission) => (
            <div key={submission.id} className="flex items-center justify-between gap-3 rounded-[1rem] border-2 border-ink bg-surface-raised p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-black">#{submission.id.slice(0, 8)}</span>
                  {selectedSubmissionId === submission.id ? <Badge variant="secondary">代表</Badge> : null}
                </div>
                <div className="text-sm font-semibold text-muted-foreground">{formatSubmissionStatus(submission)}</div>
              </div>
              <Badge variant="outline">{formatTime(submission.created_at)}</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function VotingSubmissionCard({
  submission,
  title,
  sourceLabel,
  actionLabel,
  actionIcon,
  actionVariant,
  actionDisabled,
  onAction,
}: {
  submission: GameSubmission
  title: string
  sourceLabel: string
  actionLabel: string
  actionIcon: ReactNode
  actionVariant: "outline" | "secondary"
  actionDisabled: boolean
  onAction: () => void
}) {
  return (
    <div className="grid gap-3 rounded-[1rem] border-2 border-ink bg-surface-raised p-3 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
      <TurtlePreviewPanel
        program={submission.block_program}
        trace={submission.trace}
        resultImageUrl={submission.result_image_url}
        title={title}
        sourceLabel={sourceLabel}
        viewportClassName="aspect-square h-auto"
        showTarget={false}
        showTurtle={false}
      />
      <Button variant={actionVariant} disabled={actionDisabled} onClick={onAction}>
        {actionIcon}
        {actionLabel}
      </Button>
    </div>
  )
}

function TeamSelectionPanel({
  submissions,
  selectedSubmissionId,
  isSaving,
  onSelect,
}: {
  submissions: GameSubmission[]
  selectedSubmissionId: string | null
  isSaving: boolean
  onSelect: (submissionId: string) => void
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>隊內代表作品</CardTitle>
        <CardDescription>從本回合提交中選出一件作品。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
        {submissions.length === 0 ? (
          <div className="md:col-span-2 xl:col-span-3">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>沒有可選作品</EmptyTitle>
                <EmptyDescription>本回合尚未提交成功的作品。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          submissions.map((submission) => (
            <VotingSubmissionCard
              key={submission.id}
              submission={submission}
              title={`#${submission.id.slice(0, 8)}`}
              sourceLabel={formatSubmissionStatus(submission)}
              actionLabel={selectedSubmissionId === submission.id ? "已選取" : "選為代表"}
              actionIcon={selectedSubmissionId === submission.id ? <CheckIcon data-icon="inline-start" /> : <VoteIcon data-icon="inline-start" />}
              actionVariant={selectedSubmissionId === submission.id ? "secondary" : "outline"}
              actionDisabled={isSaving}
              onAction={() => onSelect(submission.id)}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function PublicVotingPanel({
  snapshot,
  myTeamId,
  teamNameById,
  draft,
  isSaving,
  onToggle,
  onSubmit,
}: {
  snapshot: GameStateResponse
  myTeamId: string | null
  teamNameById: Map<string, string>
  draft: PublicVoteChoice[]
  isSaving: boolean
  onToggle: (submission: GameSubmission) => void
  onSubmit: () => void
}) {
  const submissionsById = useMemo(
    () => new Map(snapshot.round_submissions.map((submission) => [submission.id, submission])),
    [snapshot.round_submissions],
  )
  const nominations = snapshot.nominations
    .map((nomination) => ({
      nomination,
      submission: submissionsById.get(nomination.submission_id) ?? null,
      votes: snapshot.public_vote_counts.find((count) => count.target_submission_id === nomination.submission_id)?.vote_count ?? 0,
    }))
    .filter((item) => item.submission)

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>公開投票</CardTitle>
            <CardDescription>
              已選 {draft.length} / {snapshot.state.public_votes_per_team}
            </CardDescription>
          </div>
          <Button disabled={isSaving || draft.length === 0} onClick={onSubmit}>
            {isSaving ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
            送出投票
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
        {nominations.length === 0 ? (
          <div className="md:col-span-2 xl:col-span-3">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>尚無代表作品</EmptyTitle>
                <EmptyDescription>等待主持人進入投票階段。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          nominations.map(({ nomination, submission, votes }) => {
            if (!submission) return null
            const selected = draft.find((vote) => vote.target_submission_id === submission.id)
            const disabled = submission.team_id === myTeamId
            return (
              <VotingSubmissionCard
                key={nomination.team_id}
                submission={submission}
                title={teamNameById.get(nomination.team_id) ?? `Team ${nomination.team_id.slice(0, 6)}`}
                sourceLabel={`${votes} 票`}
                actionLabel={disabled ? "本隊作品" : selected ? `第 ${selected.rank} 順位` : "加入投票"}
                actionIcon={selected ? <CheckIcon data-icon="inline-start" /> : <VoteIcon data-icon="inline-start" />}
                actionVariant={selected ? "secondary" : "outline"}
                actionDisabled={disabled || isSaving}
                onAction={() => onToggle(submission)}
              />
            )
          })
        )}
      </CardContent>
    </Card>
  )
}

function ResultsPanel({
  snapshot,
  leaderboard,
  teamNameById,
}: {
  snapshot: GameStateResponse
  leaderboard: LeaderboardEntry[]
  teamNameById: Map<string, string>
}) {
  const submissionsById = useMemo(
    () => new Map(snapshot.round_submissions.map((submission) => [submission.id, submission])),
    [snapshot.round_submissions],
  )

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>回合結果</CardTitle>
          <CardDescription>{snapshot.results.length} 件入榜作品</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
          {snapshot.results.length === 0 ? (
            <div className="md:col-span-2 xl:col-span-3">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>等待結算</EmptyTitle>
                  <EmptyDescription>主持人結算後會顯示本回合結果。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            snapshot.results.map((result) => {
              const submission = submissionsById.get(result.submission_id)
              return (
                <div key={result.submission_id} className="grid gap-3 rounded-[1rem] border-2 border-ink bg-surface-raised p-3 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-black">#{result.rank}</div>
                      <div className="text-sm font-semibold text-muted-foreground">
                        {teamNameById.get(result.team_id) ?? `Team ${result.team_id.slice(0, 6)}`}
                      </div>
                    </div>
                    <Badge variant="secondary">{result.vote_count} 票</Badge>
                  </div>
                  <TurtlePreviewPanel
                    program={submission?.block_program}
                    trace={submission?.trace}
                    resultImageUrl={submission?.result_image_url}
                    title="作品"
                    sourceLabel={`+${result.placement_points + result.streak_bonus}`}
                    className="h-64"
                    viewportClassName="h-[calc(100%-4.5rem)]"
                    showTarget={false}
                    showTurtle={false}
                  />
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>排行榜</CardTitle>
          <CardDescription>目前總分</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 pt-4">
          {leaderboard.slice(0, 10).map((team) => (
            <div key={team.team_id} className="flex items-center justify-between gap-3 rounded-[1rem] border-2 border-ink bg-surface-raised p-3 shadow-[2px_2px_0_rgba(23,35,58,0.1)]">
              <div className="min-w-0">
                <div className="font-black">#{team.rank} {team.team_name}</div>
                <div className="text-sm font-semibold text-muted-foreground">解出 {team.solved_count}</div>
              </div>
              <div className="font-mono text-xl font-black tabular-nums">{team.total_score}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function IdlePanel() {
  return (
    <Card>
      <CardContent className="py-12">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>等待回合開始</EmptyTitle>
            <EmptyDescription>主持人開始後，小隊工作站會自動更新。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  )
}

function PhaseBadge({ phase }: { phase: GamePhase }) {
  return <Badge variant={phase === "idle" ? "outline" : "secondary"}>{phaseLabel(phase)}</Badge>
}

function useRemainingSeconds(snapshot: GameStateResponse | null | undefined) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!snapshot?.state.phase_ends_at) return null
  return Math.max(0, Math.ceil((Date.parse(snapshot.state.phase_ends_at) - now) / 1_000))
}

function keepBlocklyToolboxOpen(newWorkspace: unknown) {
  const toolbox = (newWorkspace as BlocklyWorkspaceSvgApi).getToolbox()
  if (!toolbox) return

  const typedToolbox = toolbox as BlocklyToolboxApi
  if (typedToolbox.__rtkKeepOpen) {
    typedToolbox.setVisible(true)
    return
  }

  const originalSetVisible = typedToolbox.setVisible.bind(typedToolbox)
  const originalSetSelectedItem = typedToolbox.setSelectedItem?.bind(typedToolbox)
  const getPinnedToolboxItem = () => {
    const selectedItem = typedToolbox.getSelectedItem?.()
    if (selectedItem) {
      typedToolbox.__rtkLastSelectedItem = selectedItem
      return selectedItem
    }

    return typedToolbox.__rtkLastSelectedItem ?? typedToolbox.getToolboxItems?.()[0]
  }
  const keepToolboxOpen = () => {
    originalSetVisible(true)
    const selectedItem = getPinnedToolboxItem()
    if (selectedItem && !typedToolbox.getSelectedItem?.()) {
      originalSetSelectedItem?.(selectedItem)
    }
  }

  typedToolbox.setVisible = () => originalSetVisible.call(typedToolbox, true)
  if (typedToolbox.autoHide) typedToolbox.autoHide = () => keepToolboxOpen()
  if (typedToolbox.clearSelection) typedToolbox.clearSelection = () => keepToolboxOpen()
  if (originalSetSelectedItem) {
    typedToolbox.setSelectedItem = (item: unknown) => {
      const nextItem = item ?? getPinnedToolboxItem()
      originalSetSelectedItem(nextItem)
      typedToolbox.__rtkLastSelectedItem = nextItem
      keepToolboxOpen()
    }
  }

  typedToolbox.__rtkKeepOpen = true
  keepToolboxOpen()
}

const blocklyWorkspaceConfiguration = {
  trashcan: true,
  scrollbars: true,
  move: {
    scrollbars: true,
    drag: false,
    wheel: false,
  },
  grid: {
    spacing: 24,
    length: 3,
    snap: true,
  },
  zoom: {
    controls: true,
    wheel: true,
    startScale: 0.9,
    maxScale: 1.4,
    minScale: 0.55,
    scaleSpeed: 1.1,
  },
}

function sortSubmissions(submissions: GameSubmission[]) {
  return [...submissions].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
}

function normalizeVoteRanks(votes: PublicVoteChoice[]) {
  return votes.map((vote, index) => ({ ...vote, rank: index + 1 }))
}

function phaseLabel(phase: GamePhase) {
  const labels: Record<GamePhase, string> = {
    idle: "等待中",
    submission_open: "作畫中",
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

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value))
}

function formatSubmissionStatus(submission: GameSubmission) {
  if (submission.status === "completed") return submission.error_message ? "完成但有警告" : "完成"
  if (submission.status === "failed") return "失敗"
  if (submission.status === "running") return "執行中"
  if (submission.status === "queued") return "排隊中"
  return submission.status
}
