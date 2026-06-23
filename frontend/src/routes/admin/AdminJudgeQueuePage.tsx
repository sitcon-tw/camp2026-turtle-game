import { type FormEvent, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { Challenge, Submission, SubmissionStatus, Team } from "@/lib/admin/types"

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

function QueueRow({
  submission,
  teams,
  challenges,
  isPrioritizing,
  onPrioritize,
}: {
  submission: Submission
  teams: Team[] | undefined
  challenges: Challenge[] | undefined
  isPrioritizing: boolean
  onPrioritize: (id: string, position: number) => void
}) {
  const [position, setPosition] = useState(String(Math.max(1, submission.queue_order || 1)))

  function handlePrioritize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextPosition = Number.parseInt(position, 10)
    if (Number.isFinite(nextPosition) && nextPosition > 0) {
      onPrioritize(submission.id, nextPosition)
    }
  }

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{submission.id.slice(0, 8)}</TableCell>
      <TableCell>{nameForTeam(teams, submission.team_id)}</TableCell>
      <TableCell>{titleForChallenge(challenges, submission.challenge_id)}</TableCell>
      <TableCell>
        <Badge variant={statusBadge(submission.status)}>{submission.status}</Badge>
      </TableCell>
      <TableCell>{submission.priority}</TableCell>
      <TableCell>{submission.queue_order}</TableCell>
      <TableCell>{formatDate(submission.created_at)}</TableCell>
      <TableCell>
        <form onSubmit={handlePrioritize}>
          <FieldGroup className="flex-row items-end gap-2">
            <Field>
              <FieldLabel className="sr-only" htmlFor={`position-${submission.id}`}>
                Queue position
              </FieldLabel>
              <Input
                id={`position-${submission.id}`}
                type="number"
                min={1}
                value={position}
                onChange={(event) => setPosition(event.target.value)}
                className="w-20"
              />
            </Field>
            <Button type="submit" size="sm" variant="outline" disabled={isPrioritizing}>
              Move
            </Button>
          </FieldGroup>
        </form>
      </TableCell>
    </TableRow>
  )
}

export default function AdminJudgeQueuePage() {
  const queryClient = useQueryClient()
  const queue = useQuery({
    queryKey: ["admin", "judge-queue"],
    queryFn: adminApi.judgeQueue,
    refetchInterval: 5_000,
  })
  const teams = useQuery({
    queryKey: ["admin", "teams", "judge-queue"],
    queryFn: () => adminApi.teams({}),
  })
  const challenges = useQuery({
    queryKey: ["admin", "challenges", "judge-queue"],
    queryFn: () => adminApi.challenges({}),
  })

  const pause = useMutation({
    mutationFn: adminApi.pauseQueue,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "judge-queue"] }),
  })
  const resume = useMutation({
    mutationFn: adminApi.resumeQueue,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "judge-queue"] }),
  })
  const prioritize = useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) => adminApi.prioritizeSubmission(id, position),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "judge-queue"] }),
  })

  const sortedQueue = useMemo(
    () =>
      [...(queue.data?.submissions ?? [])].sort((a, b) => {
        if (a.queue_order !== b.queue_order) return a.queue_order - b.queue_order
        return b.priority - a.priority
      }),
    [queue.data?.submissions],
  )
  const actionError = pause.error ?? resume.error ?? prioritize.error

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Queue status</CardTitle>
            <CardDescription>Current judge worker intake state.</CardDescription>
            <CardAction>
              <Badge variant={queue.data?.paused ? "destructive" : "secondary"}>
                {queue.data?.paused ? "Paused" : "Running"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-3xl font-medium">{queue.data?.queue_length ?? 0}</div>
            <p className="text-sm text-muted-foreground">submissions waiting or running</p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Queue controls</CardTitle>
            <CardDescription>Pause intake for maintenance or resume processing when judges are ready.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                disabled={pause.isPending || queue.data?.paused === true}
                onClick={() => pause.mutate()}
              >
                Pause queue
              </Button>
              <Button
                variant="outline"
                disabled={resume.isPending || queue.data?.paused === false}
                onClick={() => resume.mutate()}
              >
                Resume queue
              </Button>
              <Button variant="ghost" onClick={() => void queue.refetch()}>
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {actionError ? (
        <Card>
          <CardHeader>
            <CardTitle>Queue action failed</CardTitle>
            <CardDescription>{errorMessage(actionError)}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Judge queue</CardTitle>
          <CardDescription>Move a submission by entering a target queue position.</CardDescription>
        </CardHeader>
        <CardContent>
          {queue.isLoading || teams.isLoading || challenges.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : queue.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Unable to load judge queue</EmptyTitle>
                <EmptyDescription>{errorMessage(queue.error)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : sortedQueue.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Queue is empty</EmptyTitle>
                <EmptyDescription>New queued submissions will appear here automatically.</EmptyDescription>
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
                  <TableHead>Priority</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Prioritize</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedQueue.map((submission) => (
                  <QueueRow
                    key={submission.id}
                    submission={submission}
                    teams={teams.data}
                    challenges={challenges.data}
                    isPrioritizing={prioritize.isPending}
                    onPrioritize={(id, position) => prioritize.mutate({ id, position })}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
