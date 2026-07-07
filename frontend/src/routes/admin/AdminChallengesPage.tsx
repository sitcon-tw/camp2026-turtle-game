import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  FileUpIcon,
  ImageUpIcon,
  ListChecksIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ConfirmAction } from "@/components/admin/AdminPrimitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { Challenge, ChallengeSet } from "@/lib/admin/types"
import { cn } from "@/lib/utils"

type EnabledFilter = "all" | "enabled" | "disabled"

type ChallengeForm = {
  challenge_set_id: string
  slug: string
  title: string
  description: string
  points: string
  enabled: boolean
  order: string
}

const challengeSetsQueryKey = ["admin", "challenge-sets"] as const
const challengesQueryKey = ["admin", "challenges"] as const
const emptyChallengeSets: ChallengeSet[] = []

const emptyChallengeForm: ChallengeForm = {
  challenge_set_id: "",
  slug: "",
  title: "",
  description: "",
  points: "100",
  enabled: true,
  order: "1",
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function statusVariant(status: ChallengeSet["status"]) {
  if (status === "active") return "default"
  if (status === "archived") return "secondary"
  return "outline"
}

function setLabel(set: ChallengeSet | undefined) {
  return set ? `${set.name}（${set.version}）` : "未知題組"
}

function statusLabel(status: ChallengeSet["status"]) {
  if (status === "active") return "啟用中"
  if (status === "archived") return "已封存"
  return "草稿"
}

function sortedChallenges(challenges: Challenge[]) {
  return [...challenges].sort((left, right) => {
    return left.order - right.order || left.title.localeCompare(right.title)
  })
}

function challengeToForm(challenge: Challenge): ChallengeForm {
  return {
    challenge_set_id: challenge.challenge_set_id,
    slug: challenge.slug,
    title: challenge.title,
    description: challenge.description,
    points: String(challenge.points),
    enabled: challenge.enabled,
    order: String(challenge.order),
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function exportFileName(set: ChallengeSet) {
  return `${set.name}-${set.version}.zip`.replace(/[^\w.-]+/g, "-")
}

export default function AdminChallengesPage() {
  const queryClient = useQueryClient()
  const importInputRef = React.useRef<HTMLInputElement | null>(null)
  const imageInputRef = React.useRef<HTMLInputElement | null>(null)
  const [requestedSetId, setSelectedSetId] = React.useState("")
  const [enabledFilter, setEnabledFilter] = React.useState<EnabledFilter>("all")
  const [search, setSearch] = React.useState("")
  const [setCreateOpen, setSetCreateOpen] = React.useState(false)
  const [setImportOpen, setSetImportOpen] = React.useState(false)
  const [setForm, setSetForm] = React.useState({ name: "", version: "" })
  const [importFile, setImportFile] = React.useState<File | null>(null)
  const [challengeCreateOpen, setChallengeCreateOpen] = React.useState(false)
  const [challengeEditOpen, setChallengeEditOpen] = React.useState(false)
  const [imageOpen, setImageOpen] = React.useState(false)
  const [createForm, setCreateForm] = React.useState<ChallengeForm>(emptyChallengeForm)
  const [editForm, setEditForm] = React.useState<ChallengeForm>(emptyChallengeForm)
  const [editingChallenge, setEditingChallenge] = React.useState<Challenge | null>(null)
  const [imageChallenge, setImageChallenge] = React.useState<Challenge | null>(null)
  const [imageFile, setImageFile] = React.useState<File | null>(null)

  const setsQuery = useQuery({
    queryKey: challengeSetsQueryKey,
    queryFn: adminApi.challengeSets,
  })

  const sets = setsQuery.data ?? emptyChallengeSets
  const activeSet = sets.find((set) => set.status === "active")
  const setsById = React.useMemo(() => new Map(sets.map((set) => [set.id, set])), [sets])
  const selectedSetId = setsById.has(requestedSetId)
    ? requestedSetId
    : activeSet?.id ?? sets.find((set) => set.status === "draft")?.id ?? sets[0]?.id ?? ""

  const challengesQuery = useQuery({
    queryKey: [...challengesQueryKey, { selectedSetId }],
    queryFn: () => (selectedSetId ? adminApi.challenges({ challenge_set_id: selectedSetId }) : Promise.resolve([])),
    enabled: Boolean(selectedSetId),
  })

  const selectedSet = setsById.get(selectedSetId)
  const orderedChallenges = React.useMemo(() => sortedChallenges(challengesQuery.data ?? []), [challengesQuery.data])
  const canReorder = enabledFilter === "all" && search.trim() === ""
  const defaultCreateSetId = selectedSetId

  const visibleChallenges = React.useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return orderedChallenges.filter((challenge) => {
      if (enabledFilter === "enabled" && !challenge.enabled) return false
      if (enabledFilter === "disabled" && challenge.enabled) return false
      if (!normalizedSearch) return true
      return (
        challenge.title.toLowerCase().includes(normalizedSearch) ||
        challenge.slug.toLowerCase().includes(normalizedSearch)
      )
    })
  }, [enabledFilter, orderedChallenges, search])

  const invalidateChallengeData = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: challengeSetsQueryKey })
    void queryClient.invalidateQueries({ queryKey: challengesQueryKey })
  }, [queryClient])

  const createSet = useMutation({
    mutationFn: adminApi.createChallengeSet,
    onSuccess: (set) => {
      toast.success(`已建立 ${set.name}`)
      setSelectedSetId(set.id)
      setSetForm({ name: "", version: "" })
      setSetCreateOpen(false)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const importSet = useMutation({
    mutationFn: adminApi.importChallengeSet,
    onSuccess: (set) => {
      toast.success(`已匯入 ${set.name}`)
      setSelectedSetId(set.id)
      setImportFile(null)
      if (importInputRef.current) importInputRef.current.value = ""
      setSetImportOpen(false)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const activateSet = useMutation({
    mutationFn: adminApi.activateChallengeSet,
    onSuccess: (set) => {
      toast.success(`已啟用 ${set.name}`)
      setSelectedSetId(set.id)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const archiveSet = useMutation({
    mutationFn: adminApi.archiveChallengeSet,
    onSuccess: (set) => {
      toast.success(`已封存 ${set.name}`)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const exportSet = useMutation({
    mutationFn: async (set: ChallengeSet) => ({
      blob: await adminApi.exportChallengeSet(set.id),
      set,
    }),
    onSuccess: ({ blob, set }) => {
      downloadBlob(blob, exportFileName(set))
      toast.success(`已匯出 ${set.name}`)
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const createChallenge = useMutation({
    mutationFn: (form: ChallengeForm) =>
      adminApi.createChallenge(form.challenge_set_id, {
        slug: form.slug.trim(),
        title: form.title.trim(),
        description: form.description.trim(),
        points: Number(form.points),
        enabled: form.enabled,
        order: Number(form.order),
    }),
    onSuccess: (challenge) => {
      toast.success(`已建立 ${challenge.title}`)
      setSelectedSetId(challenge.challenge_set_id)
      setCreateForm(emptyChallengeForm)
      setChallengeCreateOpen(false)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const updateChallenge = useMutation({
    mutationFn: ({ id, form }: { id: string; form: ChallengeForm }) =>
      adminApi.updateChallenge(id, {
        title: form.title.trim(),
        description: form.description.trim(),
        points: Number(form.points),
        enabled: form.enabled,
        order: Number(form.order),
    }),
    onSuccess: (challenge) => {
      toast.success(`已更新 ${challenge.title}`)
      setEditingChallenge(null)
      setChallengeEditOpen(false)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const disableChallenge = useMutation({
    mutationFn: adminApi.disableChallenge,
    onSuccess: (challenge) => {
      toast.success(`已停用 ${challenge.title}`)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const uploadImage = useMutation({
    mutationFn: ({ challenge, file }: { challenge: Challenge; file: File }) =>
      adminApi.uploadChallengeTargetImage(challenge.id, file),
    onSuccess: (challenge) => {
      toast.success(`已上傳 ${challenge.title} 的目標圖片`)
      setImageChallenge(null)
      setImageFile(null)
      if (imageInputRef.current) imageInputRef.current.value = ""
      setImageOpen(false)
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const reorderChallenges = useMutation({
    mutationFn: adminApi.reorderChallenges,
    onSuccess: () => {
      toast.success("挑戰順序已更新")
      invalidateChallengeData()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  function submitSetCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    createSet.mutate({
      name: setForm.name.trim(),
      version: setForm.version.trim(),
    })
  }

  function submitSetImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!importFile) {
      toast.error("請選擇要匯入的挑戰題組壓縮檔。")
      return
    }
    importSet.mutate(importFile)
  }

  function openCreateChallengeDialog() {
    setCreateForm({
      ...emptyChallengeForm,
      challenge_set_id: defaultCreateSetId,
      order: String(orderedChallenges.length + 1),
    })
    setChallengeCreateOpen(true)
  }

  function openEditChallengeDialog(challenge: Challenge) {
    setEditingChallenge(challenge)
    setEditForm(challengeToForm(challenge))
    setChallengeEditOpen(true)
  }

  function openImageDialog(challenge: Challenge) {
    setImageChallenge(challenge)
    setImageFile(null)
    if (imageInputRef.current) imageInputRef.current.value = ""
    setImageOpen(true)
  }

  function submitChallengeCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const challengeSetId = createForm.challenge_set_id || defaultCreateSetId
    if (!challengeSetId) {
      toast.error("請先選擇或建立挑戰題組。")
      return
    }
    createChallenge.mutate({ ...createForm, challenge_set_id: challengeSetId })
  }

  function submitChallengeEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingChallenge) return
    updateChallenge.mutate({ id: editingChallenge.id, form: editForm })
  }

  function submitImage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!imageChallenge || !imageFile) {
      toast.error("請選擇要上傳的圖片檔案。")
      return
    }
    uploadImage.mutate({ challenge: imageChallenge, file: imageFile })
  }

  function moveChallenge(index: number, direction: -1 | 1) {
    if (!canReorder) {
      toast.error("請先清除篩選條件，再變更挑戰順序。")
      return
    }
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= orderedChallenges.length) return

    const next = [...orderedChallenges]
    const moved = next[index]
    next[index] = next[nextIndex]
    next[nextIndex] = moved
    reorderChallenges.mutate(
      next.map((challenge, orderIndex) => ({
        challenge_id: challenge.id,
        order: orderIndex + 1,
      })),
    )
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">挑戰管理</h1>
          <p className="text-sm text-muted-foreground">
            管理即時回合使用的挑戰題組與挑戰內容。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              void setsQuery.refetch()
              void challengesQuery.refetch()
            }}
            disabled={setsQuery.isFetching || challengesQuery.isFetching}
          >
            {setsQuery.isFetching || challengesQuery.isFetching ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            重新整理
          </Button>
          <Button onClick={openCreateChallengeDialog} disabled={!selectedSet}>
            <PlusIcon data-icon="inline-start" />
            新增挑戰
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <ChallengeSetRail
          sets={sets}
          selectedSetId={selectedSetId}
          isLoading={setsQuery.isLoading}
          error={setsQuery.error}
          onSelect={setSelectedSetId}
          onCreate={() => setSetCreateOpen(true)}
          onImport={() => setSetImportOpen(true)}
          onRetry={() => void setsQuery.refetch()}
        />

        <div className="grid min-w-0 gap-4">
          <SelectedSetSummary
            set={selectedSet}
            activeSet={activeSet}
            challenges={orderedChallenges}
            activatePending={activateSet.isPending}
            archivePending={archiveSet.isPending}
            exportPending={exportSet.isPending}
            onActivate={(set) => activateSet.mutate(set.id)}
            onArchive={(set) => archiveSet.mutate(set.id)}
            onExport={(set) => exportSet.mutate(set)}
          />

          <Card>
            <CardHeader className="border-b">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2">
                    <ListChecksIcon />
                    所選題組的挑戰題目
                  </CardTitle>
                  <CardDescription>
                    {selectedSet
                      ? `顯示 ${visibleChallenges.length} / ${orderedChallenges.length} 個挑戰`
                      : "請選擇或建立挑戰題組以管理挑戰。"}
                    {selectedSet && !canReorder ? " 清除篩選條件後即可調整順序。" : ""}
                  </CardDescription>
                </div>
                <ChallengeListToolbar
                  enabledFilter={enabledFilter}
                  search={search}
                  canCreate={Boolean(selectedSet)}
                  onEnabledFilterChange={setEnabledFilter}
                  onSearchChange={setSearch}
                  onCreate={openCreateChallengeDialog}
                />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ChallengesTable
                challenges={visibleChallenges}
                isLoading={setsQuery.isLoading || (Boolean(selectedSetId) && challengesQuery.isLoading)}
                error={setsQuery.error ?? challengesQuery.error}
                reorderPending={reorderChallenges.isPending}
                disablePending={disableChallenge.isPending}
                canCreate={Boolean(selectedSet)}
                canReorder={canReorder}
                onCreate={openCreateChallengeDialog}
                onEdit={openEditChallengeDialog}
                onImage={openImageDialog}
                onDisable={(challenge) => disableChallenge.mutate(challenge.id)}
                onMove={moveChallenge}
                onRetry={() => {
                  void setsQuery.refetch()
                  void challengesQuery.refetch()
                }}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={setCreateOpen} onOpenChange={setSetCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>建立挑戰題組</DialogTitle>
            <DialogDescription>建立草稿題組後，即可新增挑戰內容；也可從匯出檔匯入題組。</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitSetCreate}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="challenge-set-name">名稱</FieldLabel>
                <Input
                  id="challenge-set-name"
                  required
                  value={setForm.name}
                  onChange={(event) => setSetForm((form) => ({ ...form, name: event.target.value }))}
                  placeholder="春季決賽"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="challenge-set-version">版本</FieldLabel>
                <Input
                  id="challenge-set-version"
                  required
                  value={setForm.version}
                  onChange={(event) => setSetForm((form) => ({ ...form, version: event.target.value }))}
                  placeholder="2026.1"
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSetCreateOpen(false)}>
                  取消
                </Button>
                <Button type="submit" disabled={createSet.isPending || !setForm.name.trim() || !setForm.version.trim()}>
                  {createSet.isPending ? "建立中..." : "建立題組"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={setImportOpen} onOpenChange={setSetImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>匯入挑戰題組</DialogTitle>
            <DialogDescription>上傳由此系統匯出的挑戰題組 ZIP 檔。</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitSetImport}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="challenge-set-import">壓縮檔</FieldLabel>
                <Input
                  id="challenge-set-import"
                  ref={importInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSetImportOpen(false)}>
                  取消
                </Button>
                <Button type="submit" disabled={importSet.isPending || !importFile}>
                  {importSet.isPending ? "匯入中..." : "匯入題組"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={challengeCreateOpen} onOpenChange={setChallengeCreateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>建立挑戰</DialogTitle>
            <DialogDescription>將挑戰加入草稿或啟用中的挑戰題組。</DialogDescription>
          </DialogHeader>
          <ChallengeFormFields
            form={createForm}
            sets={sets}
            selectedSetId={createForm.challenge_set_id || defaultCreateSetId}
            mode="create"
            submitting={createChallenge.isPending}
            onChange={setCreateForm}
            onSubmit={submitChallengeCreate}
            onCancel={() => setChallengeCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={challengeEditOpen} onOpenChange={setChallengeEditOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>編輯挑戰</DialogTitle>
            <DialogDescription>更新分數、文案、啟用狀態或顯示順序。</DialogDescription>
          </DialogHeader>
          <ChallengeFormFields
            form={editForm}
            sets={sets}
            selectedSetId={editForm.challenge_set_id}
            mode="edit"
            submitting={updateChallenge.isPending}
            onChange={setEditForm}
            onSubmit={submitChallengeEdit}
            onCancel={() => setChallengeEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={imageOpen} onOpenChange={setImageOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上傳目標圖片</DialogTitle>
            <DialogDescription>
              替換「{imageChallenge?.title ?? "此挑戰"}」的目標圖片。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitImage}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="challenge-image">圖片檔案</FieldLabel>
                <Input
                  id="challenge-image"
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setImageOpen(false)}>
                  取消
                </Button>
                <Button type="submit" disabled={uploadImage.isPending || !imageFile}>
                  {uploadImage.isPending ? "上傳中..." : "上傳圖片"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ChallengeSetRail({
  sets,
  selectedSetId,
  isLoading,
  error,
  onSelect,
  onCreate,
  onImport,
  onRetry,
}: {
  sets: ChallengeSet[]
  selectedSetId: string
  isLoading: boolean
  error: unknown
  onSelect: (setId: string) => void
  onCreate: () => void
  onImport: () => void
  onRetry: () => void
}) {
  return (
    <Card className="xl:sticky xl:top-20 xl:self-start">
      <CardHeader className="border-b">
        <CardTitle>挑戰題組</CardTitle>
        <CardDescription>共 {sets.length} 個題組</CardDescription>
        <CardAction>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onImport}>
              <FileUpIcon data-icon="inline-start" />
              匯入
            </Button>
            <Button size="sm" onClick={onCreate}>
              <PlusIcon data-icon="inline-start" />
              新增
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Loader2Icon className="animate-spin" />
              </EmptyMedia>
              <EmptyTitle>正在載入挑戰題組</EmptyTitle>
              <EmptyDescription>正在取得目前的題組清單。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : error ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>無法載入挑戰題組</EmptyTitle>
              <EmptyDescription>{errorMessage(error)}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={onRetry}>
                <RefreshCwIcon data-icon="inline-start" />
                重試
              </Button>
            </EmptyContent>
          </Empty>
        ) : sets.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlusIcon />
              </EmptyMedia>
              <EmptyTitle>尚無挑戰題組</EmptyTitle>
              <EmptyDescription>建立草稿題組，或從壓縮檔匯入題組。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onCreate}>
                <PlusIcon data-icon="inline-start" />
                建立挑戰題組
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {sets.map((set) => {
              const selected = set.id === selectedSetId

              return (
                <button
                  key={set.id}
                  type="button"
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-primary bg-muted" : "border-border bg-background",
                  )}
                  onClick={() => onSelect(set.id)}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{set.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">版本 {set.version}</span>
                    </span>
                    <Badge variant={statusVariant(set.status)}>{statusLabel(set.status)}</Badge>
                  </span>
                  <span className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>{set.challenge_count ?? 0} 個挑戰</span>
                    <span className="truncate">更新於 {formatDate(set.updated_at)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SelectedSetSummary({
  set,
  activeSet,
  challenges,
  activatePending,
  archivePending,
  exportPending,
  onActivate,
  onArchive,
  onExport,
}: {
  set: ChallengeSet | undefined
  activeSet: ChallengeSet | undefined
  challenges: Challenge[]
  activatePending: boolean
  archivePending: boolean
  exportPending: boolean
  onActivate: (set: ChallengeSet) => void
  onArchive: (set: ChallengeSet) => void
  onExport: (set: ChallengeSet) => void
}) {
  if (!set) {
    return (
      <Card>
        <CardContent className="pt-(--card-spacing)">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ArchiveIcon />
              </EmptyMedia>
              <EmptyTitle>選擇挑戰題組</EmptyTitle>
              <EmptyDescription>
                挑戰題組操作與挑戰內容會顯示在這裡。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    )
  }

  const enabledCount = challenges.filter((challenge) => challenge.enabled).length
  const missingTargetCount = challenges.filter((challenge) => !challenge.target_image_asset_id).length
  const totalPoints = challenges.reduce((sum, challenge) => sum + challenge.points, 0)

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {set.name}
              <Badge variant={statusVariant(set.status)}>{statusLabel(set.status)}</Badge>
            </CardTitle>
            <CardDescription className="mt-1">
              版本 {set.version} · 更新於 {formatDate(set.updated_at)}
              {activeSet && activeSet.id !== set.id ? ` · 目前啟用題組為 ${setLabel(activeSet)}` : ""}
            </CardDescription>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => onExport(set)} disabled={exportPending}>
              <DownloadIcon data-icon="inline-start" />
              匯出
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onActivate(set)}
              disabled={set.status === "active" || activatePending}
            >
              <PlayIcon data-icon="inline-start" />
              啟用
            </Button>
            <ConfirmAction
              title="封存挑戰題組"
              description={`${set.name} 將無法用於新的即時回合。`}
              confirmLabel="封存"
              destructive
              disabled={set.status === "archived" || archivePending}
              onConfirm={() => onArchive(set)}
            >
              <Button size="sm" variant="destructive" disabled={set.status === "archived" || archivePending}>
                <ArchiveIcon data-icon="inline-start" />
                封存
              </Button>
            </ConfirmAction>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SetMetric label="挑戰數" value={String(challenges.length)} />
          <SetMetric label="已啟用" value={String(enabledCount)} />
          <SetMetric label="缺少目標圖片" value={String(missingTargetCount)} />
          <SetMetric label="總分" value={String(totalPoints)} />
        </div>
      </CardContent>
    </Card>
  )
}

function SetMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
    </div>
  )
}

function ChallengeListToolbar({
  enabledFilter,
  search,
  canCreate,
  onEnabledFilterChange,
  onSearchChange,
  onCreate,
}: {
  enabledFilter: EnabledFilter
  search: string
  canCreate: boolean
  onEnabledFilterChange: (value: EnabledFilter) => void
  onSearchChange: (value: string) => void
  onCreate: () => void
}) {
  const enabledItems = [
    { value: "all", label: "全部挑戰" },
    { value: "enabled", label: "已啟用" },
    { value: "disabled", label: "已停用" },
  ]

  return (
    <FieldGroup className="grid gap-3 sm:grid-cols-[10rem_minmax(12rem,1fr)_auto] lg:max-w-2xl">
      <Field>
        <FieldLabel>狀態</FieldLabel>
        <Select
          items={enabledItems}
          value={enabledFilter}
          onValueChange={(value) => onEnabledFilterChange(String(value) as EnabledFilter)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">全部挑戰</SelectItem>
              <SelectItem value="enabled">已啟用</SelectItem>
              <SelectItem value="disabled">已停用</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="challenge-search">搜尋</FieldLabel>
        <Input
          id="challenge-search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="識別碼或標題"
        />
      </Field>
      <Field className="justify-end">
        <FieldLabel className="invisible">建立</FieldLabel>
        <Button onClick={onCreate} disabled={!canCreate}>
          <PlusIcon data-icon="inline-start" />
          挑戰
        </Button>
      </Field>
    </FieldGroup>
  )
}

function ChallengesTable({
  challenges,
  isLoading,
  error,
  reorderPending,
  disablePending,
  canCreate,
  canReorder,
  onCreate,
  onEdit,
  onImage,
  onDisable,
  onMove,
  onRetry,
}: {
  challenges: Challenge[]
  isLoading: boolean
  error: unknown
  reorderPending: boolean
  disablePending: boolean
  canCreate: boolean
  canReorder: boolean
  onCreate: () => void
  onEdit: (challenge: Challenge) => void
  onImage: (challenge: Challenge) => void
  onDisable: (challenge: Challenge) => void
  onMove: (index: number, direction: -1 | 1) => void
  onRetry: () => void
}) {
  if (isLoading) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Loader2Icon className="animate-spin" />
          </EmptyMedia>
          <EmptyTitle>正在載入挑戰</EmptyTitle>
          <EmptyDescription>正在取得挑戰內容。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>無法載入挑戰</EmptyTitle>
          <EmptyDescription>{errorMessage(error)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            重試
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  if (challenges.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PlusIcon />
          </EmptyMedia>
          <EmptyTitle>{canCreate ? "沒有符合條件的挑戰" : "尚未選擇挑戰題組"}</EmptyTitle>
          <EmptyDescription>
            {canCreate ? "請建立挑戰或調整目前的篩選條件。" : "請先選擇或建立題組。"}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onCreate} disabled={!canCreate}>
            <PlusIcon data-icon="inline-start" />
            建立挑戰
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>順序</TableHead>
          <TableHead>挑戰</TableHead>
          <TableHead className="text-right">分數</TableHead>
          <TableHead>目標圖片</TableHead>
          <TableHead>狀態</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {challenges.map((challenge, index) => (
          <TableRow key={challenge.id}>
            <TableCell>{challenge.order}</TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <span className="font-medium">{challenge.title}</span>
                <span className="max-w-72 truncate text-xs text-muted-foreground">{challenge.slug}</span>
              </div>
            </TableCell>
            <TableCell className="text-right font-medium">{challenge.points}</TableCell>
            <TableCell>
              {challenge.target_image_asset_id ? (
                <Badge variant="secondary">已上傳</Badge>
              ) : (
                <Badge variant="outline">缺少</Badge>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={challenge.enabled ? "default" : "secondary"}>
                {challenge.enabled ? "已啟用" : "已停用"}
              </Badge>
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-2">
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="將挑戰上移"
                  disabled={!canReorder || index === 0 || reorderPending}
                  onClick={() => onMove(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="將挑戰下移"
                  disabled={!canReorder || index === challenges.length - 1 || reorderPending}
                  onClick={() => onMove(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button size="sm" variant="outline" onClick={() => onImage(challenge)}>
                  <ImageUpIcon data-icon="inline-start" />
                  圖片
                </Button>
                <Button size="sm" variant="outline" onClick={() => onEdit(challenge)}>
                  <PencilIcon data-icon="inline-start" />
                  編輯
                </Button>
                <ConfirmAction
                  title="停用挑戰"
                  description={`${challenge.title} 將對隊伍隱藏，且無法用於新回合。`}
                  confirmLabel="停用"
                  destructive
                  disabled={!challenge.enabled || disablePending}
                  onConfirm={() => onDisable(challenge)}
                >
                  <Button size="sm" variant="destructive" disabled={!challenge.enabled || disablePending}>
                    <XCircleIcon data-icon="inline-start" />
                    停用
                  </Button>
                </ConfirmAction>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function ChallengeFormFields({
  form,
  sets,
  selectedSetId,
  mode,
  submitting,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: ChallengeForm
  sets: ChallengeSet[]
  selectedSetId: string
  mode: "create" | "edit"
  submitting: boolean
  onChange: React.Dispatch<React.SetStateAction<ChallengeForm>>
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}) {
  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel>挑戰題組</FieldLabel>
          <Select
            items={sets.map((set) => ({ value: set.id, label: setLabel(set) }))}
            value={selectedSetId}
            onValueChange={(value) => onChange((current) => ({ ...current, challenge_set_id: String(value) }))}
            disabled={mode === "edit"}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sets.map((set) => (
                  <SelectItem key={set.id} value={set.id}>
                    {setLabel(set)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${mode}-challenge-slug`}>識別碼</FieldLabel>
          <Input
            id={`${mode}-challenge-slug`}
            required
            disabled={mode === "edit"}
            value={form.slug}
            onChange={(event) => onChange((current) => ({ ...current, slug: event.target.value }))}
            placeholder="例如：hua-yi-dong-fang-zi"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${mode}-challenge-title`}>標題</FieldLabel>
          <Input
            id={`${mode}-challenge-title`}
            required
            value={form.title}
            onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))}
            placeholder="畫一棟房子"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${mode}-challenge-description`}>描述</FieldLabel>
          <Textarea
            id={`${mode}-challenge-description`}
            value={form.description}
            onChange={(event) => onChange((current) => ({ ...current, description: event.target.value }))}
            placeholder="描述隊伍應該畫什麼。"
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${mode}-challenge-points`}>分數</FieldLabel>
            <Input
              id={`${mode}-challenge-points`}
              type="number"
              min="0"
              required
              value={form.points}
              onChange={(event) => onChange((current) => ({ ...current, points: event.target.value }))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${mode}-challenge-order`}>順序</FieldLabel>
            <Input
              id={`${mode}-challenge-order`}
              type="number"
              min="1"
              required
              value={form.order}
              onChange={(event) => onChange((current) => ({ ...current, order: event.target.value }))}
            />
          </Field>
        </div>
        <Field orientation="horizontal">
          <Switch
            id={`${mode}-challenge-enabled`}
            checked={form.enabled}
            onCheckedChange={(checked) => onChange((current) => ({ ...current, enabled: checked }))}
          />
          <FieldContent>
            <FieldLabel htmlFor={`${mode}-challenge-enabled`}>啟用</FieldLabel>
            <FieldDescription>停用的挑戰仍會對管理員顯示，但會對隊伍隱藏。</FieldDescription>
          </FieldContent>
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button
            type="submit"
            disabled={submitting || !selectedSetId || !form.slug.trim() || !form.title.trim()}
          >
            {submitting ? "儲存中..." : mode === "create" ? "建立挑戰" : "儲存變更"}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  )
}
