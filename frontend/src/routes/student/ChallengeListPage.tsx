import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ArrowRightIcon, ClockIcon, MedalIcon, SparklesIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { studentApi } from "@/lib/student/api"
import { useStudentEvents } from "@/hooks/use-student-events"
import type { MyQueueResponse } from "@/lib/student/types"

type ChallengeCard = {
  id: string
  title?: string
  name?: string
  description?: string
  status?: string
  status_label?: string
  active?: boolean
  submission_count?: number
  best_similarity?: number | null
  points?: number | null
  awarded_points?: number | null
}

type QueueItem = {
  id: string
  challenge_id?: string
  challenge_title?: string
  status?: string
  position?: number | null
  created_at?: string
  submitted_at?: string
}

function formatPercent(value: number | null | undefined) {
  if (value == null) return "-"
  return `${Math.round(value * 100)}%`
}

function formatPoints(value: number | null | undefined) {
  if (value == null) return "-"
  return `${value} 分`
}

function statusLabel(status: string | undefined) {
  if (!status) return "開放中"
  const labels: Record<string, string> = {
    active: "開放中",
    open: "開放中",
    submitted: "已送出",
    queued: "排隊中",
    judging: "評分中",
    scored: "已評分",
  }
  return labels[status] ?? status
}

export default function ChallengeListPage() {
  useStudentEvents({
    invalidate: [["student", "challenges"], ["student", "queue"]],
  })

  const challenges = useQuery({
    queryKey: ["student", "challenges"],
    queryFn: studentApi.challenges,
  })

  const queue = useQuery({
    queryKey: ["student", "queue"],
    queryFn: studentApi.myQueue,
  })

  const activeChallenges = ((challenges.data ?? []) as ChallengeCard[]).filter((challenge) => challenge.active ?? !["closed", "archived", "inactive"].includes(challenge.status ?? ""))
  const queueItems = queueItemsFromResponse(queue.data)

  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_22rem]">
      <section className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">學生挑戰</p>
          <h1 className="text-3xl font-semibold tracking-tight">目前開放的挑戰</h1>
          <p className="text-muted-foreground">查看目前開放的題目、送出狀態與評分結果。</p>
        </div>

        {challenges.isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-56 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
        ) : activeChallenges.length === 0 ? (
          <Card>
            <CardContent className="p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>目前沒有開放的挑戰</EmptyTitle>
                  <EmptyDescription>請稍後重新整理，或等待工作人員開放題目。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {activeChallenges.map((challenge) => (
              <Card key={challenge.id} className="bg-background/80">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <Badge variant="secondary">{challenge.status_label ?? statusLabel(challenge.status)}</Badge>
                      <CardTitle>{challenge.title ?? challenge.name ?? "未命名挑戰"}</CardTitle>
                    </div>
                    <SparklesIcon className="size-5 text-muted-foreground" />
                  </div>
                  <CardDescription>{challenge.description ?? "題目資訊與目前成績。"}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl border bg-muted/40 p-3">
                      <p className="text-muted-foreground">送出次數</p>
                      <p className="mt-1 text-lg font-semibold">{challenge.submission_count ?? 0}</p>
                    </div>
                    <div className="rounded-xl border bg-muted/40 p-3">
                      <p className="text-muted-foreground">最佳相似度</p>
                      <p className="mt-1 text-lg font-semibold">{formatPercent(challenge.best_similarity)}</p>
                    </div>
                    <div className="rounded-xl border bg-muted/40 p-3">
                      <p className="text-muted-foreground">滿分</p>
                      <p className="mt-1 text-lg font-semibold">{formatPoints(challenge.points)}</p>
                    </div>
                    <div className="rounded-xl border bg-muted/40 p-3">
                      <p className="text-muted-foreground">已得分</p>
                      <p className="mt-1 text-lg font-semibold">{formatPoints(challenge.awarded_points)}</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    nativeButton={false}
                    render={<Link to={`/challenges/${challenge.id}`} />}
                  >
                    開始挑戰
                    <ArrowRightIcon data-icon="inline-end" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <aside className="space-y-4">
        <Card className="bg-background/80">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ClockIcon className="size-5 text-muted-foreground" />
              <CardTitle>評分佇列</CardTitle>
            </div>
            <CardDescription>此區會隨學生事件更新，顯示你的送出等待狀態。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {queue.isLoading ? <Skeleton className="h-24 rounded-xl" /> : null}
            {!queue.isLoading && queueItems.length === 0 ? <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">目前沒有等待中的送出。</p> : null}
            {queueItems.map((item) => (
              <div key={item.id} className="rounded-xl border bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{item.challenge_title ?? "挑戰送出"}</p>
                  <Badge variant="outline">{statusLabel(item.status)}</Badge>
                </div>
                <p className="mt-2 text-muted-foreground">{item.position ? `佇列順位 ${item.position}` : "等待系統更新狀態"}</p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="bg-background/80">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
            <MedalIcon className="size-5 text-foreground" />
            最高分會以評分結果更新，請以挑戰卡片上的「已得分」為準。
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}

function queueItemsFromResponse(data: MyQueueResponse | undefined): QueueItem[] {
  if (!data) return []

  return [
    ...data.queued_submissions.map(({ submission, position }) => ({
      id: submission.id,
      challenge_id: submission.challenge_id,
      status: submission.status,
      position,
      created_at: submission.created_at,
      submitted_at: submission.created_at,
    })),
    ...(data.running_submission
      ? [
          {
            id: data.running_submission.submission.id,
            challenge_id: data.running_submission.submission.challenge_id,
            status: data.running_submission.submission.status,
            position: data.running_submission.position,
            created_at: data.running_submission.submission.created_at,
            submitted_at: data.running_submission.submission.created_at,
          },
        ]
      : []),
  ]
}
