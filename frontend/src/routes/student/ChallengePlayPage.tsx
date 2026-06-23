import { useMemo, useState } from "react"
import type { Workspace } from "blockly/core"
import { BlocklyWorkspace } from "react-blockly"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftIcon, Loader2Icon, PlayIcon, SendIcon } from "lucide-react"
import { Link, useParams } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { TurtlePreviewPanel } from "@/components/turtle"
import { useStudentEvents } from "@/hooks/use-student-events"
import { reactBlocklyToolboxCategories, registerTurtleBlocks } from "@/lib/blockly"
import { studentApi, studentErrorMessage } from "@/lib/student/api"
import type { Submission } from "@/lib/student/types"

import {
  buildWorkspaceProgramSnapshot,
  queueItemsForChallenge,
  solvedText,
  statusTextForSubmission,
  submitWorkspaceProgram,
} from "./ChallengePlayPage.logic"

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

export default function ChallengePlayPage() {
  const { challengeId } = useParams<{ challengeId: string }>()
  const queryClient = useQueryClient()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [previewProgram, setPreviewProgram] = useState<unknown | null>(null)
  const [animationKey, setAnimationKey] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)

  useStudentEvents({
    enabled: Boolean(challengeId),
    invalidate: [
      ["student", "challenge", challengeId],
      ["student", "challenge", "submissions", challengeId],
      ["student", "queue"],
    ],
  })

  const challenge = useQuery({
    queryKey: ["student", "challenge", challengeId],
    queryFn: () => studentApi.challenge(challengeId ?? ""),
    enabled: Boolean(challengeId),
  })

  const submissions = useQuery({
    queryKey: ["student", "challenge", "submissions", challengeId],
    queryFn: () => studentApi.challengeSubmissions(challengeId ?? ""),
    enabled: Boolean(challengeId),
  })

  const queue = useQuery({
    queryKey: ["student", "queue"],
    queryFn: studentApi.myQueue,
    enabled: Boolean(challengeId),
  })

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!workspace || !challenge.data) throw new Error("工作區尚未準備好")
      return submitWorkspaceProgram({
        workspace,
        canvas: challenge.data.canvas,
        challengeId: challenge.data.id,
        createSubmission: studentApi.createSubmission,
      })
    },
    onSuccess: async ({ program }) => {
      setPreviewProgram(program)
      setAnimationKey((key) => key + 1)
      setActionError(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["student", "challenge", challengeId] }),
        queryClient.invalidateQueries({ queryKey: ["student", "challenge", "submissions", challengeId] }),
        queryClient.invalidateQueries({ queryKey: ["student", "queue"] }),
      ])
    },
    onError: (error) => setActionError(studentErrorMessage(error)),
  })

  const currentQueueItems = useMemo(
    () => queueItemsForChallenge(queue.data, challengeId),
    [challengeId, queue.data],
  )
  const currentSubmissions = useMemo(
    () => sortSubmissionsForDisplay(submissions.data ?? [], challengeId),
    [challengeId, submissions.data],
  )
  const queuedSubmissionIds = useMemo(
    () => new Set(currentQueueItems.map((item) => item.submission.id)),
    [currentQueueItems],
  )
  const historySubmissions = useMemo(
    () => currentSubmissions.filter((submission) => !queuedSubmissionIds.has(submission.id)),
    [currentSubmissions, queuedSubmissionIds],
  )
  const solved = challenge.data?.status === "solved" || currentSubmissions.some((submission) => submission.passed)
  const isWorkspaceReady = Boolean(workspace && challenge.data)
  const blocklyWorkspaceConfiguration = useMemo(
    () => ({
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
        colour: "rgba(100, 116, 139, 0.28)",
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
    }),
    [],
  )

  function executeProgram() {
    if (!workspace || !challenge.data) return

    try {
      const { program } = buildWorkspaceProgramSnapshot(workspace, challenge.data.canvas)
      setPreviewProgram(program)
      setAnimationKey((key) => key + 1)
      setActionError(null)
    } catch (error) {
      setActionError(studentErrorMessage(error))
    }
  }

  function handleWorkspaceInject(newWorkspace: unknown) {
    setWorkspace(newWorkspace as unknown as Workspace)

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

    if (typedToolbox.autoHide) {
      typedToolbox.autoHide = () => keepToolboxOpen()
    }

    if (typedToolbox.clearSelection) {
      typedToolbox.clearSelection = () => keepToolboxOpen()
    }

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

  if (!challengeId) {
    return <NavigateBackMessage title="找不到挑戰" description="請回到挑戰列表重新選擇題目。" />
  }

  if (challenge.isLoading) {
    return (
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6">
        <Skeleton className="h-12 rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <Skeleton className="h-[680px] rounded-xl" />
          <Skeleton className="h-[680px] rounded-xl" />
        </div>
      </div>
    )
  }

  if (challenge.isError || !challenge.data) {
    return <NavigateBackMessage title="無法載入挑戰" description="請確認題目是否仍開放，或回到挑戰列表重新選擇。" />
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <Button variant="ghost" size="sm" className="w-fit" nativeButton={false} render={<Link to="/challenges" />}>
            <ArrowLeftIcon data-icon="inline-start" />
            回挑戰列表
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{challenge.data.title}</h1>
            <Badge variant={solved ? "default" : "secondary"}>{solvedText(solved)}</Badge>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">{challenge.data.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={executeProgram} disabled={!isWorkspaceReady}>
            <PlayIcon data-icon="inline-start" />
            執行
          </Button>
          <Button onClick={() => submitMutation.mutate()} disabled={!isWorkspaceReady || submitMutation.isPending}>
            {submitMutation.isPending ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
            提交
          </Button>
        </div>
      </div>

      {actionError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card className="h-[680px] bg-background/80 p-0">
          <CardContent className="min-h-0 flex-1 p-0">
            <BlocklyWorkspace
              className="h-full w-full"
              initialXml={EMPTY_WORKSPACE_XML}
              toolboxConfiguration={reactBlocklyToolboxCategories}
              workspaceConfiguration={blocklyWorkspaceConfiguration}
              onInject={handleWorkspaceInject}
              onDispose={() => setWorkspace(null)}
              onImportXmlError={(error) => setActionError(studentErrorMessage(error))}
            />
          </CardContent>
        </Card>

        <aside className="flex flex-col gap-4">
          <Card className="bg-background/80">
            <CardHeader>
              <CardTitle>預覽</CardTitle>
              <CardDescription>執行只會播放目前工作區，不會提交答案。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="aspect-square">
                <TurtlePreviewPanel
                  challenge={challenge.data}
                  program={previewProgram ?? undefined}
                  title="預覽"
                  sourceLabel={previewProgram ? "block program" : "no program"}
                  animated={Boolean(previewProgram)}
                  animationKey={animationKey}
                  compact
                  showTarget
                  showTurtle
                  className="h-full w-full rounded-lg"
                  viewportClassName="h-full"
                  rendererClassName="h-full"
                  canvasClassName="h-full w-full"
                />
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-muted-foreground">畫布</p>
                  <p className="font-medium">
                    {challenge.data.canvas.width} x {challenge.data.canvas.height}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-muted-foreground">狀態</p>
                  <p className="font-medium">{solvedText(solved)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-background/80">
            <CardHeader>
              <CardTitle>提交紀錄</CardTitle>
              <CardDescription>只顯示目前挑戰的佇列與評測狀態。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {queue.isLoading || submissions.isLoading ? <Skeleton className="h-20 rounded-lg" /> : null}

              {currentQueueItems.map((item) => (
                <div key={item.submission.id} className="rounded-lg border bg-muted/30 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">#{item.submission.attempt_no} 等待評測中</p>
                    <Badge variant="secondary">順位 {item.position}</Badge>
                  </div>
                  <p className="mt-2 text-muted-foreground">{formatDateTime(item.submission.created_at)}</p>
                </div>
              ))}

              {!queue.isLoading && !submissions.isLoading && currentSubmissions.length === 0 && currentQueueItems.length === 0 ? (
                <Empty className="rounded-lg border border-dashed p-4">
                  <EmptyHeader>
                    <EmptyTitle>尚未解出</EmptyTitle>
                    <EmptyDescription>執行可以先預覽，準備好後再提交。</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}

              {historySubmissions.map((submission) => (
                <SubmissionHistoryItem key={submission.id} submission={submission} />
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  )
}

function SubmissionHistoryItem({ submission }: { submission: Submission }) {
  return (
    <div className="rounded-lg border bg-background p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">#{submission.attempt_no}</p>
        <Badge variant={submission.passed ? "default" : "outline"}>{statusTextForSubmission(submission)}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-muted-foreground">
        <span>{formatDateTime(submission.created_at)}</span>
        {submission.similarity == null ? null : <span>相似度 {Math.round(submission.similarity * 100)}%</span>}
        {submission.awarded_points == null ? null : <span>{submission.awarded_points} 分</span>}
      </div>
    </div>
  )
}

function NavigateBackMessage({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{title}</EmptyTitle>
              <EmptyDescription>{description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <Button className="w-fit" nativeButton={false} render={<Link to="/challenges" />}>
            回挑戰列表
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function sortSubmissionsForDisplay(submissions: Submission[], challengeId: string | undefined) {
  return submissions
    .filter((submission) => !challengeId || submission.challenge_id === challengeId)
    .toSorted((first, second) => Date.parse(second.created_at) - Date.parse(first.created_at))
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "時間未定"
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}
