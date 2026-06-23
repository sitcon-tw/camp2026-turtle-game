import { type FormEvent, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AdminSubmissionPreview } from "@/components/admin/AdminSubmissionPreview"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { Challenge, SubmissionStatus, Team } from "@/lib/admin/types"

const statusItems = [
  { label: "All statuses", value: "all" },
  { label: "Queued", value: "queued" },
  { label: "Running", value: "running" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
]

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

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-"
  return `${Math.round(value * 100)}%`
}

function statusBadge(status: SubmissionStatus) {
  if (status === "completed") return "secondary"
  if (status === "failed" || status === "cancelled") return "destructive"
  if (status === "running") return "default"
  return "outline"
}

function selectedStatus(value: string): SubmissionStatus | "" {
  return value === "all" ? "" : (value as SubmissionStatus)
}

function nameForTeam(teams: Team[] | undefined, id: string) {
  return teams?.find((team) => team.id === id)?.name ?? id.slice(0, 8)
}

function titleForChallenge(challenges: Challenge[] | undefined, id: string) {
  return challenges?.find((challenge) => challenge.id === id)?.title ?? id.slice(0, 8)
}

export default function AdminSubmissionsPage() {
  const queryClient = useQueryClient()
  const [teamId, setTeamId] = useState("")
  const [challengeId, setChallengeId] = useState("")
  const [status, setStatus] = useState("all")

  const teams = useQuery({
    queryKey: ["admin", "teams", "submission-filters"],
    queryFn: () => adminApi.teams({}),
  })
  const challenges = useQuery({
    queryKey: ["admin", "challenges", "submission-filters"],
    queryFn: () => adminApi.challenges({}),
  })
  const submissions = useQuery({
    queryKey: ["admin", "submissions", { teamId, challengeId, status }],
    queryFn: () =>
      adminApi.submissions({
        team_id: teamId,
        challenge_id: challengeId,
        status: selectedStatus(status),
      }),
  })

  const retry = useMutation({
    mutationFn: adminApi.retrySubmission,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "submissions"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "judge-queue"] }),
      ]),
  })
  const cancel = useMutation({
    mutationFn: adminApi.cancelSubmission,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "submissions"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "judge-queue"] }),
      ]),
  })

  const sortedSubmissions = useMemo(
    () =>
      [...(submissions.data ?? [])].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [submissions.data],
  )
  const hasFilters = Boolean(teamId || challengeId || status !== "all")
  const actionError = retry.error ?? cancel.error

  function clearFilters() {
    setTeamId("")
    setChallengeId("")
    setStatus("all")
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void submissions.refetch()
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Submissions</CardTitle>
          <CardDescription>Inspect attempts, retry failed work, and cancel pending queue entries.</CardDescription>
          <CardAction>
            <Button variant="outline" onClick={() => void submissions.refetch()}>
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup className="grid gap-4 md:grid-cols-4">
              <Field>
                <FieldLabel htmlFor="team-filter">Team ID</FieldLabel>
                <Input
                  id="team-filter"
                  value={teamId}
                  onChange={(event) => setTeamId(event.target.value)}
                  placeholder="Any team"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="challenge-filter">Challenge ID</FieldLabel>
                <Input
                  id="challenge-filter"
                  value={challengeId}
                  onChange={(event) => setChallengeId(event.target.value)}
                  placeholder="Any challenge"
                />
              </Field>
              <Field>
                <FieldLabel>Status</FieldLabel>
                <Select items={statusItems} value={status} onValueChange={(value) => setStatus(String(value))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {statusItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field className="justify-end">
                <FieldLabel className="sr-only">Filter actions</FieldLabel>
                <div className="flex gap-2">
                  <Button type="submit" variant="outline">
                    Apply
                  </Button>
                  <Button type="button" variant="ghost" disabled={!hasFilters} onClick={clearFilters}>
                    Clear
                  </Button>
                </div>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {actionError ? (
        <Card>
          <CardHeader>
            <CardTitle>Action failed</CardTitle>
            <CardDescription>{errorMessage(actionError)}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Submission log</CardTitle>
          <CardDescription>
            {submissions.data?.length ?? 0} matching submissions. Team and challenge names are resolved when available.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {submissions.isLoading || teams.isLoading || challenges.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : submissions.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Unable to load submissions</EmptyTitle>
                <EmptyDescription>{errorMessage(submissions.error)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : sortedSubmissions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No submissions match</EmptyTitle>
                <EmptyDescription>Adjust filters or wait for teams to submit new attempts.</EmptyDescription>
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
                  <TableHead>Similarity</TableHead>
                  <TableHead>Points</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Preview</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedSubmissions.map((submission) => (
                  <TableRow key={submission.id}>
                    <TableCell className="font-mono text-xs">{submission.id.slice(0, 8)}</TableCell>
                    <TableCell>{nameForTeam(teams.data, submission.team_id)}</TableCell>
                    <TableCell>{titleForChallenge(challenges.data, submission.challenge_id)}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadge(submission.status)}>{submission.status}</Badge>
                    </TableCell>
                    <TableCell>{formatPercent(submission.similarity)}</TableCell>
                    <TableCell>{submission.awarded_points ?? "-"}</TableCell>
                    <TableCell>{formatDate(submission.created_at)}</TableCell>
                    <TableCell>
                      <AdminSubmissionPreview submission={submission} compact />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(submission.id)}
                        >
                          Retry
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={cancel.isPending || !["queued", "running"].includes(submission.status)}
                          onClick={() => cancel.mutate(submission.id)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
