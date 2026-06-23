import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { Submission, SubmissionStatus } from "@/lib/admin/types"

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

function formatDate(value: string | null | undefined) {
  if (!value) return "Never"
  return dateFormatter.format(new Date(value))
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-"
  return `${Math.round(value * 100)}%`
}

function countByStatus(submissions: Submission[]) {
  return submissions.reduce<Record<SubmissionStatus, number>>(
    (counts, submission) => {
      counts[submission.status] += 1
      return counts
    },
    { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
  )
}

function statusBadge(status: SubmissionStatus) {
  if (status === "completed") return "secondary"
  if (status === "failed" || status === "cancelled") return "destructive"
  if (status === "running") return "default"
  return "outline"
}

function StatCard({
  title,
  value,
  description,
  badge,
}: {
  title: string
  value: string | number
  description: string
  badge?: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {badge ? (
          <CardAction>
            <Badge variant="outline">{badge}</Badge>
          </CardAction>
        ) : null}
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="font-heading text-3xl font-medium">{value}</div>
      </CardContent>
    </Card>
  )
}

function LoadingCard() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-9 w-20" />
      </CardContent>
    </Card>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unable to load overview</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  )
}

export default function AdminOverviewPage() {
  const teams = useQuery({
    queryKey: ["admin", "teams", "overview"],
    queryFn: () => adminApi.teams({}),
  })
  const challengeSets = useQuery({
    queryKey: ["admin", "challenge-sets", "overview"],
    queryFn: adminApi.challengeSets,
  })
  const submissions = useQuery({
    queryKey: ["admin", "submissions", "overview"],
    queryFn: () => adminApi.submissions({}),
  })
  const queue = useQuery({
    queryKey: ["admin", "judge-queue", "overview"],
    queryFn: adminApi.judgeQueue,
    refetchInterval: 5_000,
  })
  const leaderboard = useQuery({
    queryKey: ["admin", "leaderboard", "overview"],
    queryFn: adminApi.leaderboard,
  })
  const readiness = useQuery({
    queryKey: ["admin", "readiness", "overview"],
    queryFn: adminApi.readiness,
  })

  const activeSet = useMemo(
    () => challengeSets.data?.find((set) => set.status === "active") ?? null,
    [challengeSets.data],
  )
  const statusCounts = useMemo(() => countByStatus(submissions.data ?? []), [submissions.data])
  const recentSubmissions = useMemo(
    () =>
      [...(submissions.data ?? [])]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6),
    [submissions.data],
  )
  const enabledTeams = teams.data?.filter((team) => team.enabled).length ?? 0
  const topTeams = leaderboard.data?.teams.slice(0, 5) ?? []
  const isLoading =
    teams.isLoading || challengeSets.isLoading || submissions.isLoading || queue.isLoading || leaderboard.isLoading
  const error = teams.error ?? challengeSets.error ?? submissions.error ?? queue.error ?? leaderboard.error ?? null

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <LoadingCard />
          <LoadingCard />
          <LoadingCard />
          <LoadingCard />
        </div>
        <LoadingCard />
      </div>
    )
  }

  if (error) {
    return <ErrorCard message={errorMessage(error)} />
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Teams"
          value={teams.data?.length ?? 0}
          description={`${enabledTeams} enabled teams are eligible to play.`}
          badge="Roster"
        />
        <StatCard
          title="Active set"
          value={activeSet?.challenge_count ?? 0}
          description={activeSet ? `${activeSet.name} ${activeSet.version}` : "No active challenge set."}
          badge={activeSet?.status ?? "none"}
        />
        <StatCard
          title="Judge queue"
          value={queue.data?.queue_length ?? 0}
          description={queue.data?.paused ? "Queue processing is paused." : "Queue processing is active."}
          badge={queue.data?.paused ? "Paused" : "Running"}
        />
        <StatCard
          title="Submissions"
          value={submissions.data?.length ?? 0}
          description={`${statusCounts.completed} completed, ${statusCounts.failed} failed.`}
          badge={`${statusCounts.queued + statusCounts.running} active`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Recent submissions</CardTitle>
            <CardDescription>Latest judge activity across all teams and challenges.</CardDescription>
          </CardHeader>
          <CardContent>
            {recentSubmissions.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No submissions yet</EmptyTitle>
                  <EmptyDescription>Submissions will appear here after teams start sending attempts.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Submission</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Similarity</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentSubmissions.map((submission) => (
                    <TableRow key={submission.id}>
                      <TableCell className="font-mono text-xs">{submission.id.slice(0, 8)}</TableCell>
                      <TableCell>
                        <Badge variant={statusBadge(submission.status)}>{submission.status}</Badge>
                      </TableCell>
                      <TableCell>{formatPercent(submission.similarity)}</TableCell>
                      <TableCell>{submission.awarded_points ?? "-"}</TableCell>
                      <TableCell>{formatDate(submission.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Top leaderboard</CardTitle>
              <CardDescription>Updated {formatDate(leaderboard.data?.updated_at)}</CardDescription>
            </CardHeader>
            <CardContent>
              {topTeams.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No scores yet</EmptyTitle>
                    <EmptyDescription>The leaderboard is waiting for score events.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead>Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topTeams.map((team) => (
                      <TableRow key={team.team_id}>
                        <TableCell>{team.rank}</TableCell>
                        <TableCell>{team.team_name}</TableCell>
                        <TableCell>{team.total_score}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>System readiness</CardTitle>
              <CardDescription>Backend service dependencies.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">API</span>
                  <Badge variant={readiness.data?.ok ? "secondary" : "destructive"}>
                    {readiness.data?.ok ? "Ready" : "Not ready"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Database</span>
                  <Badge variant={readiness.data?.database === "ok" ? "secondary" : "outline"}>
                    {readiness.data?.database ?? "unknown"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Storage</span>
                  <Badge variant={readiness.data?.storage === "ok" ? "secondary" : "outline"}>
                    {readiness.data?.storage ?? "unknown"}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
