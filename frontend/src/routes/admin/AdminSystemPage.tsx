import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { adminApi, errorMessage } from "@/lib/admin/api"

function serviceBadge(ok: boolean | undefined) {
  if (ok === undefined) return <Badge variant="outline">Unknown</Badge>
  return <Badge variant={ok ? "secondary" : "destructive"}>{ok ? "OK" : "Failed"}</Badge>
}

function dependencyBadge(value: string | undefined) {
  if (!value) return <Badge variant="outline">Unknown</Badge>
  return <Badge variant={value === "ok" ? "secondary" : "destructive"}>{value}</Badge>
}

export default function AdminSystemPage() {
  const queryClient = useQueryClient()
  const health = useQuery({
    queryKey: ["admin", "system", "health"],
    queryFn: adminApi.health,
  })
  const readiness = useQuery({
    queryKey: ["admin", "system", "readiness"],
    queryFn: adminApi.readiness,
  })
  const me = useQuery({
    queryKey: ["admin", "me"],
    queryFn: adminApi.me,
  })
  const queue = useQuery({
    queryKey: ["admin", "judge-queue", "system"],
    queryFn: adminApi.judgeQueue,
  })

  const recalculateScores = useMutation({
    mutationFn: adminApi.recalculateScores,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "teams"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "leaderboard"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "blackboard"] }),
      ]),
  })
  const recalculateAwards = useMutation({
    mutationFn: adminApi.recalculateChallengeAwards,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "teams"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "leaderboard"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "blackboard"] }),
      ]),
  })
  const pause = useMutation({
    mutationFn: adminApi.pauseQueue,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "judge-queue"] }),
  })
  const resume = useMutation({
    mutationFn: adminApi.resumeQueue,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "judge-queue"] }),
  })

  const actionError = recalculateScores.error ?? recalculateAwards.error ?? pause.error ?? resume.error

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>API health</CardTitle>
            <CardDescription>Liveness status from the backend.</CardDescription>
            <CardAction>{serviceBadge(health.data?.ok)}</CardAction>
          </CardHeader>
          <CardContent>
            {health.isLoading ? <Skeleton className="h-8 w-24" /> : <p className="text-sm text-muted-foreground">Health check endpoint is reachable.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Readiness</CardTitle>
            <CardDescription>Database and storage dependency checks.</CardDescription>
            <CardAction>{serviceBadge(readiness.data?.ok)}</CardAction>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Database</span>
                {dependencyBadge(readiness.data?.database)}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Storage</span>
                {dependencyBadge(readiness.data?.storage)}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Admin session</CardTitle>
            <CardDescription>Current authenticated admin principal.</CardDescription>
            <CardAction>
              <Badge variant={me.data?.role === "admin" ? "secondary" : "outline"}>{me.data?.role ?? "unknown"}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="truncate font-mono text-sm">{me.data?.subject ?? "No session subject loaded."}</p>
          </CardContent>
        </Card>
      </div>

      {health.isError || readiness.isError || me.isError ? (
        <Card>
          <CardHeader>
            <CardTitle>System status error</CardTitle>
            <CardDescription>{errorMessage(health.error ?? readiness.error ?? me.error)}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {actionError ? (
        <Card>
          <CardHeader>
            <CardTitle>Operation failed</CardTitle>
            <CardDescription>{errorMessage(actionError)}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Queue operations</CardTitle>
            <CardDescription>Operational controls for judge processing.</CardDescription>
            <CardAction>
              <Badge variant={queue.data?.paused ? "destructive" : "secondary"}>
                {queue.data?.paused ? "Paused" : "Running"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Pause judge queue</FieldTitle>
                  <FieldDescription>Stop queue processing before maintenance or data repair.</FieldDescription>
                </FieldContent>
                <Button
                  variant="destructive"
                  disabled={pause.isPending || queue.data?.paused === true}
                  onClick={() => pause.mutate()}
                >
                  Pause
                </Button>
              </Field>
              <Separator />
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Resume judge queue</FieldTitle>
                  <FieldDescription>Allow queued submissions to continue processing.</FieldDescription>
                </FieldContent>
                <Button
                  variant="outline"
                  disabled={resume.isPending || queue.data?.paused === false}
                  onClick={() => resume.mutate()}
                >
                  Resume
                </Button>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Score maintenance</CardTitle>
            <CardDescription>Rebuild derived scores from persisted score and submission data.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Recalculate team totals</FieldTitle>
                  <FieldDescription>Refresh team total scores from score events.</FieldDescription>
                </FieldContent>
                <Button
                  variant="outline"
                  disabled={recalculateScores.isPending}
                  onClick={() => recalculateScores.mutate()}
                >
                  Recalculate
                </Button>
              </Field>
              <Separator />
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Recalculate challenge awards</FieldTitle>
                  <FieldDescription>Rebuild awarded points for challenge submissions.</FieldDescription>
                </FieldContent>
                <Button
                  variant="outline"
                  disabled={recalculateAwards.isPending}
                  onClick={() => recalculateAwards.mutate()}
                >
                  Rebuild awards
                </Button>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Operational notes</CardTitle>
          <CardDescription>Safe order for larger maintenance windows.</CardDescription>
        </CardHeader>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Recommended maintenance flow</EmptyTitle>
              <EmptyDescription>
                Pause the queue, run score maintenance, confirm readiness is OK, then resume queue processing.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  )
}
