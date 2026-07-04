import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, ReactNode, RefObject } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ClockIcon, CrownIcon, TrophyIcon } from "lucide-react"

import { ChallengeRenderer } from "@/components/turtle"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type {
  BlackboardState,
  BlackboardTeam,
  GameChallenge,
  GameStateResponse,
  GameSubmission,
  LeaderboardEntry,
  RoundResultEntry,
} from "@/lib/game/types"
import { cn } from "@/lib/utils"

const BOARD_ASPECT_RATIO = 16 / 9

type TeamArtwork = {
  key: string
  team: BlackboardTeam
  submission: GameSubmission | null
  badge: string
  meta: string
  highlight?: boolean
}

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
      <main className="h-svh overflow-hidden bg-background p-3 lg:p-4">
        <div className="grid h-full gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="min-h-0 flex-1" />
        </div>
      </main>
    )
  }

  if (blackboard.isError || !blackboard.data) {
    return (
      <main className="flex h-svh items-center justify-center overflow-hidden bg-background p-4">
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
    <main className="relative h-svh overflow-hidden bg-background p-3 lg:p-4">
      <PhaseView data={blackboard.data} />
      <TimerBlock snapshot={blackboard.data.game} />
    </main>
  )
}

function PhaseView({ data }: { data: BlackboardState }) {
  if (data.game.state.phase === "submission_open") return <SubmissionOpenView data={data} />
  if (data.game.state.phase === "team_selection") return <TeamSelectionView data={data} />
  if (data.game.state.phase === "public_voting") return <PublicVotingView data={data} />
  if (data.game.state.phase === "round_complete" || data.game.state.phase === "scoring") return <RoundCompleteView data={data} />
  return <IdleView data={data} />
}

function SubmissionOpenView({ data }: { data: BlackboardState }) {
  const teams = useEnabledTeams(data)
  const latestByTeam = useMemo(() => latestSubmissionsByTeam(data.game.round_submissions), [data.game.round_submissions])
  const items = useMemo<TeamArtwork[]>(
    () =>
      teams.map((team) => {
        const submission = latestByTeam.get(team.id) ?? null
        return {
          key: team.id,
          team,
          submission,
          badge: submission ? `#${submission.attempt_no}` : "等待",
          meta: submission ? formatSubmissionStatus(submission) : "尚未送出",
        }
      }),
    [latestByTeam, teams],
  )

  return (
    <BoardShell
      title="最新作品"
      subtitle={data.game.challenge ? `${data.game.challenge.title} / Submission Open` : "Submission Open"}
    >
      <AdaptiveArtworkGrid items={items} challenge={data.game.challenge} mode="submission" />
    </BoardShell>
  )
}

function TeamSelectionView({ data }: { data: BlackboardState }) {
  const teams = useEnabledTeams(data)
  const submissionsById = useSubmissionMap(data.game.round_submissions)
  const nominationsByTeam = useMemo(
    () => new Map(data.game.nominations.map((nomination) => [nomination.team_id, nomination])),
    [data.game.nominations],
  )
  const items = useMemo<TeamArtwork[]>(
    () =>
      teams.map((team) => {
        const nomination = nominationsByTeam.get(team.id)
        const submission = nomination ? submissionsById.get(nomination.submission_id) ?? null : null
        return {
          key: team.id,
          team,
          submission,
          badge: nomination ? "已選出" : "選取中",
          meta: nomination ? "代表作品" : "尚未選出",
          highlight: Boolean(nomination),
        }
      }),
    [nominationsByTeam, submissionsById, teams],
  )

  return (
    <BoardShell
      title="隊伍代表作品"
      subtitle={data.game.challenge ? `${data.game.challenge.title} / Team Selection` : "Team Selection"}
    >
      <AdaptiveArtworkGrid items={items} challenge={data.game.challenge} mode="selection" />
    </BoardShell>
  )
}

function PublicVotingView({ data }: { data: BlackboardState }) {
  const teams = useEnabledTeams(data)
  const teamById = useTeamMap(data.teams)
  const submissionsById = useSubmissionMap(data.game.round_submissions)
  const voteCountsBySubmission = useMemo(
    () => new Map(data.game.public_vote_counts.map((count) => [count.target_submission_id, count.vote_count])),
    [data.game.public_vote_counts],
  )
  const nominationItems = useMemo<TeamArtwork[]>(() => {
    const nominatedTeams: TeamArtwork[] = []
    for (const nomination of data.game.nominations) {
      const team = teamById.get(nomination.team_id)
      const votes = voteCountsBySubmission.get(nomination.submission_id) ?? 0
      if (!team) continue
      nominatedTeams.push({
        key: nomination.team_id,
        team,
        submission: submissionsById.get(nomination.submission_id) ?? null,
        badge: `${votes} 票`,
        meta: "公開投票",
        highlight: votes > 0,
      })
    }

    const presentTeamIds = new Set(nominatedTeams.map((item) => item.team.id))
    const missingTeams: TeamArtwork[] = teams
      .filter((team) => !presentTeamIds.has(team.id))
      .map((team) => ({
        key: team.id,
        team,
        submission: null,
        badge: "0 票",
        meta: "尚無代表作品",
      }))

    return [...nominatedTeams, ...missingTeams].sort(
      (left, right) => readVoteCount(right.badge) - readVoteCount(left.badge) || left.team.name.localeCompare(right.team.name),
    )
  }, [data.game.nominations, submissionsById, teamById, teams, voteCountsBySubmission])

  return (
    <BoardShell
      title="公開投票"
      subtitle={data.game.challenge ? `${data.game.challenge.title} / Public Voting` : "Public Voting"}
    >
      <AdaptiveArtworkGrid items={nominationItems} challenge={data.game.challenge} mode="voting" />
    </BoardShell>
  )
}

function RoundCompleteView({ data }: { data: BlackboardState }) {
  const teamById = useTeamMap(data.teams)
  const submissionsById = useSubmissionMap(data.game.round_submissions)
  const enabledTeamIds = useMemo(() => new Set(data.teams.filter((team) => team.enabled).map((team) => team.id)), [data.teams])
  const visibleLeaderboard = useMemo(
    () => data.leaderboard.filter((team) => enabledTeamIds.has(team.team_id)),
    [data.leaderboard, enabledTeamIds],
  )
  const results = useMemo(
    () => [...data.game.results].sort((left, right) => left.rank - right.rank),
    [data.game.results],
  )
  const winner = results[0] ?? null
  const winnerTeam = winner ? teamById.get(winner.team_id) ?? null : null
  const winnerSubmission = winner ? submissionsById.get(winner.submission_id) ?? null : null
  const animationKey = `${data.game.state.current_round_id ?? "round"}:${winner?.submission_id ?? data.game.state.version}`

  return (
    <BoardShell
      title="回合結果"
      subtitle={data.game.challenge ? `${data.game.challenge.title} / Round Complete` : "Round Complete"}
    >
      <RoundCompleteSequence
        key={animationKey}
        winner={winner}
        winnerTeam={winnerTeam}
        winnerSubmission={winnerSubmission}
        challenge={data.game.challenge}
        leaderboard={visibleLeaderboard}
        results={results}
      />
    </BoardShell>
  )
}

function IdleView({ data }: { data: BlackboardState }) {
  return (
    <BoardShell
      title="等待回合開始"
      subtitle={data.game.challenge ? data.game.challenge.title : "Idle"}
    >
      <div className="flex h-full min-h-0 items-center justify-center rounded-[1rem] border-2 border-dashed border-border bg-surface-raised/70">
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-4xl">等待回合開始</EmptyTitle>
            <EmptyDescription className="text-xl">主持人開始後黑板會自動更新。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </BoardShell>
  )
}

function BoardShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-[1.375rem] border-2 border-ink bg-card p-3 text-card-foreground shadow-[4px_4px_0_rgba(23,35,58,0.12)]">
      <header className="min-w-0 pr-36 lg:pr-44">
        <div className="truncate text-2xl font-semibold leading-tight lg:text-4xl">{title}</div>
        <div className="mt-1 truncate text-sm text-muted-foreground lg:text-base">{subtitle}</div>
      </header>
      <div className="min-h-0">{children}</div>
    </section>
  )
}

function AdaptiveArtworkGrid({
  items,
  challenge,
  mode,
}: {
  items: TeamArtwork[]
  challenge: GameChallenge | null
  mode: "submission" | "selection" | "voting"
}) {
  const aspectRatio = challengeAspectRatio(challenge)
  const viewportAspectRatio = useViewportAspectRatio()
  const tracks = adaptiveGridTracks(items.length, aspectRatio, viewportAspectRatio)
  const tileRefs = useRef(new Map<string, HTMLElement>())
  useVotingSwapAnimation(tileRefs, mode === "voting")
  const gridStyle = {
    gridTemplateColumns: `repeat(${tracks.columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${tracks.rows}, minmax(0, 1fr))`,
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center rounded-[1rem] border-2 border-dashed border-border bg-surface-raised/70">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>沒有啟用隊伍</EmptyTitle>
            <EmptyDescription>啟用隊伍後作品會出現在黑板上。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 gap-3" style={gridStyle}>
      {items.map((item, index) => (
        <SubmissionTile
          key={item.key}
          item={item}
          challenge={challenge}
          aspectRatio={aspectRatio}
          mode={mode}
          ref={(element) => {
            if (element) tileRefs.current.set(item.key, element)
            else tileRefs.current.delete(item.key)
          }}
          style={{ animationDelay: mode === "voting" ? "0ms" : `${index * 45}ms` }}
        />
      ))}
    </div>
  )
}

const SubmissionTile = forwardRef<HTMLElement, {
  item: TeamArtwork
  challenge: GameChallenge | null
  aspectRatio: number
  mode: "submission" | "selection" | "voting"
  style?: CSSProperties
}>(function SubmissionTile(
{
  item,
  challenge,
  aspectRatio,
  mode,
  style,
},
ref,
) {
  const isVoteBadge = mode === "voting"

  return (
    <article
      ref={ref}
      className={cn(
        "animate-in fade-in zoom-in-95 grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden rounded-[1rem] border-2 border-ink bg-surface-raised duration-300 shadow-[3px_3px_0_rgba(23,35,58,0.12)]",
        mode === "voting" ? "will-change-transform" : undefined,
        item.highlight ? "ring-2 ring-primary/30" : undefined,
      )}
      style={style}
    >
      <SubmissionArtwork
        submission={item.submission}
        challenge={challenge}
        aspectRatio={aspectRatio}
        animated={mode === "submission"}
      />
      <footer className="grid min-h-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t-2 border-ink bg-card/90 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-base font-black lg:text-xl">{item.team.name}</div>
          <div className="truncate text-xs font-semibold text-muted-foreground lg:text-sm">{item.meta}</div>
        </div>
        <Badge
          variant={item.highlight ? "default" : "secondary"}
          className={cn(
            "font-mono font-semibold tabular-nums",
            isVoteBadge ? "h-12 px-4 text-2xl lg:h-14 lg:px-5 lg:text-3xl" : "h-7 text-sm",
          )}
        >
          {item.badge}
        </Badge>
      </footer>
    </article>
  )
})

function SubmissionArtwork({
  submission,
  challenge,
  aspectRatio,
  animated,
}: {
  submission: GameSubmission | null
  challenge: GameChallenge | null
  aspectRatio: number
  animated: boolean
}) {
  if (!submission) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden p-3" style={{ containerType: "size" }}>
        <div
          className="flex items-center justify-center rounded-[1rem] border-2 border-dashed border-border bg-background text-center text-sm font-semibold text-muted-foreground"
          style={canvasFrameStyle(aspectRatio)}
        >
          作品尚未載入
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden p-2" style={{ containerType: "size" }}>
      <div
        className="overflow-hidden rounded-[1rem] border-2 border-ink bg-background shadow-[2px_2px_0_rgba(23,35,58,0.1)]"
        style={canvasFrameStyle(aspectRatio)}
      >
        <ChallengeRenderer
          challenge={challenge}
          program={submission.block_program}
          trace={submission.trace}
          resultImageUrl={submission.result_image_url}
          animated={animated && submission.status === "completed"}
          animationKey={submission.id}
          showTarget={false}
          showTurtle={animated}
          className="h-full w-full"
          canvasClassName="h-full w-full"
        />
      </div>
    </div>
  )
}

function RoundCompleteSequence({
  winner,
  winnerTeam,
  winnerSubmission,
  challenge,
  leaderboard,
  results,
}: {
  winner: RoundResultEntry | null
  winnerTeam: BlackboardTeam | null
  winnerSubmission: GameSubmission | null
  challenge: GameChallenge | null
  leaderboard: LeaderboardEntry[]
  results: RoundResultEntry[]
}) {
  const [showLeaderboard, setShowLeaderboard] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setShowLeaderboard(true), winner ? 2_200 : 250)
    return () => window.clearTimeout(timer)
  }, [winner])

  return (
    <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)]">
      <WinnerPanel
        result={winner}
        team={winnerTeam}
        submission={winnerSubmission}
        challenge={challenge}
      />
      {showLeaderboard ? (
        <LeaderboardPanel leaderboard={leaderboard} results={results} />
      ) : (
        <div className="hidden min-h-0 rounded-[1rem] border-2 border-dashed border-border bg-surface-raised/70 lg:block" />
      )}
    </div>
  )
}

function WinnerPanel({
  result,
  team,
  submission,
  challenge,
}: {
  result: RoundResultEntry | null
  team: BlackboardTeam | null
  submission: GameSubmission | null
  challenge: GameChallenge | null
}) {
  const totalPoints = result ? result.placement_points + result.streak_bonus : 0

  if (!result) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center rounded-[1rem] border-2 border-dashed border-border bg-surface-raised/70">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>等待結算</EmptyTitle>
            <EmptyDescription>主持人結算後會顯示本回合結果。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <section className="animate-in fade-in zoom-in-95 grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[1rem] border-2 border-ink bg-surface-raised duration-700 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
      <div className="flex min-w-0 items-center justify-between gap-4 border-b-2 border-ink bg-card/90 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CrownIcon data-icon="inline-start" />
            Winner
          </div>
          <div className="truncate text-3xl font-semibold lg:text-5xl">{team?.name ?? `Team ${result.team_id.slice(0, 6)}`}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-5xl font-semibold tabular-nums lg:text-7xl">#{result.rank}</div>
          <div className="text-sm text-muted-foreground">{result.vote_count} 票</div>
        </div>
      </div>
      <SubmissionArtwork
        submission={submission}
        challenge={challenge}
        aspectRatio={challengeAspectRatio(challenge)}
        animated
      />
      <div className="grid grid-cols-3 gap-2 border-t-2 border-ink bg-card/90 px-4 py-3 text-center">
        <ResultStat label="得票" value={result.vote_count} />
        <ResultStat label="名次分" value={`+${result.placement_points}`} />
        <ResultStat label="連勝加分" value={`+${result.streak_bonus}`} detail={`${totalPoints} total`} />
      </div>
    </section>
  )
}

function ResultStat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="min-w-0 rounded-[0.875rem] border border-border bg-background/80 px-2 py-2 shadow-[1px_1px_0_rgba(23,35,58,0.08)]">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-2xl font-semibold tabular-nums lg:text-3xl">{value}</div>
      {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

function LeaderboardPanel({ leaderboard, results }: { leaderboard: LeaderboardEntry[]; results: RoundResultEntry[] }) {
  const resultByTeam = useMemo(() => new Map(results.map((result) => [result.team_id, result])), [results])
  const rows = leaderboard.length > 0 ? leaderboard : []

  return (
    <section className="animate-in fade-in slide-in-from-right-4 grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[1rem] border-2 border-ink bg-surface-raised duration-700 shadow-[3px_3px_0_rgba(23,35,58,0.12)]">
      <header className="flex items-center justify-between gap-4 border-b-2 border-ink bg-card/90 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <TrophyIcon data-icon="inline-start" />
            Leaderboard
          </div>
          <div className="truncate text-2xl font-semibold lg:text-3xl">總分排行</div>
        </div>
      </header>
      <div className="grid min-h-0 gap-2 p-3" style={{ gridTemplateRows: `repeat(${Math.max(rows.length, 1)}, minmax(0, 1fr))` }}>
        {rows.length === 0 ? (
          <div className="flex items-center justify-center rounded-[0.875rem] border-2 border-dashed border-border bg-background/70 text-muted-foreground">
            尚無分數
          </div>
        ) : (
          rows.map((team, index) => {
            const roundResult = resultByTeam.get(team.team_id)
            const roundPoints = roundResult ? roundResult.placement_points + roundResult.streak_bonus : 0
            const displayRank = index + 1
            return (
              <div
                key={team.team_id}
                className={cn(
                  "animate-in fade-in slide-in-from-bottom-3 grid min-h-0 grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-[0.875rem] border border-border bg-background/75 px-3 py-2 duration-500 shadow-[1px_1px_0_rgba(23,35,58,0.08)]",
                  displayRank === 1 ? "ring-2 ring-primary/25" : undefined,
                )}
                style={{ animationDelay: `${index * 120}ms` }}
              >
                <div className="font-mono text-2xl font-semibold tabular-nums lg:text-3xl">#{displayRank}</div>
                <div className="min-w-0">
                  <div className="truncate text-lg font-semibold lg:text-2xl">{team.team_name}</div>
                  <div className="truncate text-xs text-muted-foreground lg:text-sm">
                    {roundPoints > 0 ? `本回合 +${roundPoints}` : `解出 ${team.solved_count}`}
                  </div>
                </div>
                <div className="font-mono text-2xl font-semibold tabular-nums lg:text-4xl">{team.total_score}</div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

function TimerBlock({ snapshot }: { snapshot: GameStateResponse }) {
  const seconds = useRemainingSeconds(snapshot)

  return (
    <div className="absolute right-5 top-5 flex items-center gap-2 rounded-[1rem] border border-border bg-card/95 px-3 py-2 shadow-[2px_2px_0_rgba(23,35,58,0.1)]">
      <ClockIcon data-icon="inline-start" />
      <div className="font-mono text-2xl font-semibold tabular-nums lg:text-3xl">{formatTimer(seconds)}</div>
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

function useEnabledTeams(data: BlackboardState) {
  return useMemo(() => data.teams.filter((team) => team.enabled), [data.teams])
}

function useTeamMap(teams: BlackboardTeam[]) {
  return useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams])
}

function useSubmissionMap(submissions: GameSubmission[]) {
  return useMemo(() => new Map(submissions.map((submission) => [submission.id, submission])), [submissions])
}

function useVotingSwapAnimation(tileRefs: RefObject<Map<string, HTMLElement>>, enabled: boolean) {
  const previousRects = useRef(new Map<string, DOMRect>())

  useLayoutEffect(() => {
    const currentRects = new Map<string, DOMRect>()
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    for (const [key, element] of tileRefs.current) {
      const rect = element.getBoundingClientRect()
      currentRects.set(key, rect)

      const previousRect = previousRects.current.get(key)
      if (!enabled || reduceMotion || !previousRect) continue

      const deltaX = previousRect.left - rect.left
      const deltaY = previousRect.top - rect.top
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue

      element.getAnimations().forEach((animation) => animation.cancel())
      element.animate(
        [
          {
            transform: `translate(${deltaX}px, ${deltaY}px)`,
            zIndex: "2",
          },
          {
            transform: "translate(0, 0)",
            zIndex: "2",
          },
        ],
        {
          duration: 650,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        },
      )
    }

    previousRects.current = currentRects
  })
}

function latestSubmissionsByTeam(submissions: GameSubmission[]) {
  const latest = new Map<string, GameSubmission>()
  for (const submission of submissions) {
    const current = latest.get(submission.team_id)
    if (!current || compareSubmissionRecency(submission, current) > 0) latest.set(submission.team_id, submission)
  }
  return latest
}

function compareSubmissionRecency(left: GameSubmission, right: GameSubmission) {
  return (
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.attempt_no - right.attempt_no ||
    left.id.localeCompare(right.id)
  )
}

function useViewportAspectRatio() {
  const [aspectRatio, setAspectRatio] = useState(() => readViewportAspectRatio())

  useEffect(() => {
    const updateAspectRatio = () => setAspectRatio(readViewportAspectRatio())
    window.addEventListener("resize", updateAspectRatio)
    window.visualViewport?.addEventListener("resize", updateAspectRatio)
    return () => {
      window.removeEventListener("resize", updateAspectRatio)
      window.visualViewport?.removeEventListener("resize", updateAspectRatio)
    }
  }, [])

  return aspectRatio
}

function readViewportAspectRatio() {
  if (typeof window === "undefined") return BOARD_ASPECT_RATIO
  const width = window.innerWidth || 16
  const height = window.innerHeight || 9
  return width / height
}

function adaptiveGridTracks(count: number, itemAspectRatio: number, viewportAspectRatio: number) {
  const safeCount = Math.max(1, count)
  let best = { columns: 1, rows: safeCount, score: -Infinity }

  for (let columns = 1; columns <= safeCount; columns += 1) {
    const rows = Math.ceil(safeCount / columns)
    const cellAspectRatio = viewportAspectRatio * (rows / columns)
    const fit = Math.min(cellAspectRatio / itemAspectRatio, itemAspectRatio / cellAspectRatio)
    const filledCells = safeCount / (columns * rows)
    const cellArea = 1 / (columns * rows)
    const score = cellArea * fit * (0.86 + filledCells * 0.14)

    if (score > best.score) best = { columns, rows, score }
  }

  return best
}

function challengeAspectRatio(challenge: GameChallenge | null) {
  const width = challenge?.canvas.width ?? 640
  const height = challenge?.canvas.height ?? 480
  return width > 0 && height > 0 ? width / height : 4 / 3
}

function canvasFrameStyle(aspectRatio: number): CSSProperties {
  return {
    aspectRatio: String(aspectRatio),
    height: `min(100%, calc(100cqw / ${aspectRatio}))`,
    width: `min(100%, calc(100cqh * ${aspectRatio}))`,
  }
}

function formatTimer(seconds: number | null) {
  if (seconds === null) return "--:--"
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

function formatSubmissionStatus(submission: GameSubmission) {
  if (submission.status === "completed") return "完成"
  if (submission.status === "failed") return "失敗"
  if (submission.status === "running") return "執行中"
  if (submission.status === "queued") return "排隊中"
  return submission.status
}

function readVoteCount(label: string) {
  const parsed = Number.parseInt(label, 10)
  return Number.isFinite(parsed) ? parsed : 0
}
