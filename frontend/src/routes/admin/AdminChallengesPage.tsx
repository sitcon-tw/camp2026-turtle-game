import { useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ImageUpIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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

type ChallengeForm = {
  challenge_set_id: string
  slug: string
  title: string
  description: string
  points: string
  pass_threshold: string
  enabled: boolean
  order: string
}

const emptyChallengeForm: ChallengeForm = {
  challenge_set_id: "",
  slug: "",
  title: "",
  description: "",
  points: "100",
  pass_threshold: "0.9",
  enabled: true,
  order: "1",
}

const challengeSetsQueryKey = ["admin", "challenge-sets"] as const

function challengesQueryKey(setId: string, status: string) {
  return ["admin", "challenges", setId, status] as const
}

function sortedChallenges(challenges: Challenge[]) {
  return [...challenges].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function setLabel(set: ChallengeSet | undefined) {
  return set ? `${set.name} (${set.version})` : "Unknown set"
}

function challengeToForm(challenge: Challenge): ChallengeForm {
  return {
    challenge_set_id: challenge.challenge_set_id,
    slug: challenge.slug,
    title: challenge.title,
    description: challenge.description,
    points: String(challenge.points),
    pass_threshold: String(challenge.pass_threshold),
    enabled: challenge.enabled,
    order: String(challenge.order),
  }
}

export default function AdminChallengesPage() {
  const queryClient = useQueryClient()
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const [setFilter, setSetFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [search, setSearch] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [imageOpen, setImageOpen] = useState(false)
  const [createForm, setCreateForm] = useState<ChallengeForm>(emptyChallengeForm)
  const [editForm, setEditForm] = useState<ChallengeForm>(emptyChallengeForm)
  const [editingChallenge, setEditingChallenge] = useState<Challenge | null>(null)
  const [imageChallenge, setImageChallenge] = useState<Challenge | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)

  const setsQuery = useQuery({
    queryKey: challengeSetsQueryKey,
    queryFn: adminApi.challengeSets,
  })

  const challengesQuery = useQuery({
    queryKey: challengesQueryKey(setFilter, statusFilter),
    queryFn: () =>
      adminApi.challenges({
        challenge_set_id: setFilter === "all" ? undefined : setFilter,
        active_only: statusFilter === "active" ? true : undefined,
      }),
  })

  const sets = setsQuery.data ?? []
  const setsById = useMemo(() => new Map(sets.map((set) => [set.id, set])), [sets])
  const selectedCreateSetId = createForm.challenge_set_id || (setFilter !== "all" ? setFilter : "") || sets[0]?.id || ""

  const filteredChallenges = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return sortedChallenges(challengesQuery.data ?? []).filter((challenge) => {
      if (statusFilter === "disabled" && challenge.enabled) return false
      if (!normalizedSearch) return true
      return (
        challenge.title.toLowerCase().includes(normalizedSearch) ||
        challenge.slug.toLowerCase().includes(normalizedSearch)
      )
    })
  }, [challengesQuery.data, search, statusFilter])

  const invalidateChallenges = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "challenges"] })
    void queryClient.invalidateQueries({ queryKey: challengeSetsQueryKey })
  }

  const createChallenge = useMutation({
    mutationFn: (form: ChallengeForm) =>
      adminApi.createChallenge(form.challenge_set_id, {
        slug: form.slug.trim(),
        title: form.title.trim(),
        description: form.description.trim(),
        points: Number(form.points),
        pass_threshold: Number(form.pass_threshold),
        enabled: form.enabled,
        order: Number(form.order),
      }),
    onSuccess: (challenge) => {
      toast.success(`Created ${challenge.title}`)
      setCreateForm(emptyChallengeForm)
      setCreateOpen(false)
      invalidateChallenges()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const updateChallenge = useMutation({
    mutationFn: ({ id, form }: { id: string; form: ChallengeForm }) =>
      adminApi.updateChallenge(id, {
        title: form.title.trim(),
        description: form.description.trim(),
        points: Number(form.points),
        pass_threshold: Number(form.pass_threshold),
        enabled: form.enabled,
        order: Number(form.order),
      }),
    onSuccess: (challenge) => {
      toast.success(`Updated ${challenge.title}`)
      setEditingChallenge(null)
      setEditOpen(false)
      invalidateChallenges()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const disableChallenge = useMutation({
    mutationFn: adminApi.disableChallenge,
    onSuccess: (challenge) => {
      toast.success(`Disabled ${challenge.title}`)
      invalidateChallenges()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const uploadImage = useMutation({
    mutationFn: ({ challenge, file }: { challenge: Challenge; file: File }) =>
      adminApi.uploadChallengeImage(challenge.id, file),
    onSuccess: (challenge) => {
      toast.success(`Uploaded image for ${challenge.title}`)
      setImageChallenge(null)
      setImageFile(null)
      if (imageInputRef.current) imageInputRef.current.value = ""
      setImageOpen(false)
      invalidateChallenges()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const reorderChallenges = useMutation({
    mutationFn: adminApi.reorderChallenges,
    onSuccess: () => {
      toast.success("Challenge order updated")
      invalidateChallenges()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  function openCreateDialog() {
    setCreateForm({
      ...emptyChallengeForm,
      challenge_set_id: selectedCreateSetId,
      order: String(filteredChallenges.length + 1),
    })
    setCreateOpen(true)
  }

  function openEditDialog(challenge: Challenge) {
    setEditingChallenge(challenge)
    setEditForm(challengeToForm(challenge))
    setEditOpen(true)
  }

  function openImageDialog(challenge: Challenge) {
    setImageChallenge(challenge)
    setImageFile(null)
    if (imageInputRef.current) imageInputRef.current.value = ""
    setImageOpen(true)
  }

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const challengeSetId = createForm.challenge_set_id || selectedCreateSetId
    if (!challengeSetId) {
      toast.error("Choose a challenge set before creating a challenge.")
      return
    }
    createChallenge.mutate({ ...createForm, challenge_set_id: challengeSetId })
  }

  function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingChallenge) return
    updateChallenge.mutate({ id: editingChallenge.id, form: editForm })
  }

  function submitImage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!imageChallenge || !imageFile) {
      toast.error("Choose an image file to upload.")
      return
    }
    uploadImage.mutate({ challenge: imageChallenge, file: imageFile })
  }

  function moveChallenge(index: number, direction: -1 | 1) {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= filteredChallenges.length) return
    const next = [...filteredChallenges]
    const current = next[index]
    next[index] = next[nextIndex]
    next[nextIndex] = current
    reorderChallenges.mutate(
      next.map((challenge, orderIndex) => ({
        challenge_id: challenge.id,
        order: orderIndex + 1,
      })),
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Challenges</h1>
          <p className="text-sm text-muted-foreground">
            Filter, create, edit, upload targets, disable, and reorder challenges.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void challengesQuery.refetch()} disabled={challengesQuery.isFetching}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
          <Button onClick={openCreateDialog} disabled={sets.length === 0}>
            <PlusIcon data-icon="inline-start" />
            New challenge
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Narrow the admin challenge list by set, status, or slug/title.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
            <Field>
              <FieldLabel>Challenge set</FieldLabel>
              <Select items={[{ value: "all", label: "All sets" }, ...sets.map((set) => ({ value: set.id, label: setLabel(set) }))]} value={setFilter} onValueChange={(value) => setSetFilter(String(value))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All sets" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All sets</SelectItem>
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
              <FieldLabel>Status</FieldLabel>
              <Select items={[{ value: "all", label: "All statuses" }, { value: "active", label: "Enabled only" }, { value: "disabled", label: "Disabled only" }]} value={statusFilter} onValueChange={(value) => setStatusFilter(String(value))}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Enabled only</SelectItem>
                    <SelectItem value="disabled">Disabled only</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="challenge-search">Search</FieldLabel>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="challenge-search"
                  className="pl-8"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Slug or title"
                />
              </div>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Challenge list</CardTitle>
          <CardDescription>{filteredChallenges.length} visible challenge records</CardDescription>
        </CardHeader>
        <CardContent>
          {setsQuery.isLoading || challengesQuery.isLoading ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RefreshCwIcon />
                </EmptyMedia>
                <EmptyTitle>Loading challenges</EmptyTitle>
                <EmptyDescription>Fetching sets and challenge records.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : setsQuery.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Challenge sets could not be loaded</EmptyTitle>
                <EmptyDescription>{errorMessage(setsQuery.error)}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : challengesQuery.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Challenges could not be loaded</EmptyTitle>
                <EmptyDescription>{errorMessage(challengesQuery.error)}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => void challengesQuery.refetch()}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Try again
                </Button>
              </EmptyContent>
            </Empty>
          ) : filteredChallenges.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlusIcon />
                </EmptyMedia>
                <EmptyTitle>No challenges match</EmptyTitle>
                <EmptyDescription>Create a challenge or relax the current filters.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={openCreateDialog} disabled={sets.length === 0}>
                  <PlusIcon data-icon="inline-start" />
                  Create challenge
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Challenge</TableHead>
                  <TableHead>Set</TableHead>
                  <TableHead>Points</TableHead>
                  <TableHead>Pass</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredChallenges.map((challenge, index) => (
                  <TableRow key={challenge.id}>
                    <TableCell>{challenge.order}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">{challenge.title}</span>
                        <span className="text-xs text-muted-foreground">{challenge.slug}</span>
                      </div>
                    </TableCell>
                    <TableCell>{setLabel(setsById.get(challenge.challenge_set_id))}</TableCell>
                    <TableCell>{challenge.points}</TableCell>
                    <TableCell>{formatPercent(challenge.pass_threshold)}</TableCell>
                    <TableCell>
                      {challenge.target_image_url ? (
                        <Badge variant="secondary">Uploaded</Badge>
                      ) : (
                        <Badge variant="outline">Missing</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={challenge.enabled ? "default" : "secondary"}>
                        {challenge.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="icon-sm"
                          variant="outline"
                          aria-label="Move challenge up"
                          disabled={index === 0 || reorderChallenges.isPending}
                          onClick={() => moveChallenge(index, -1)}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="outline"
                          aria-label="Move challenge down"
                          disabled={index === filteredChallenges.length - 1 || reorderChallenges.isPending}
                          onClick={() => moveChallenge(index, 1)}
                        >
                          <ArrowDownIcon />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openImageDialog(challenge)}>
                          <ImageUpIcon data-icon="inline-start" />
                          Image
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openEditDialog(challenge)}>
                          <PencilIcon data-icon="inline-start" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={!challenge.enabled || disableChallenge.isPending}
                          onClick={() => disableChallenge.mutate(challenge.id)}
                        >
                          <XCircleIcon data-icon="inline-start" />
                          Disable
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

      <Dialog open={createOpen} onOpenChange={(open) => setCreateOpen(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create challenge</DialogTitle>
            <DialogDescription>Add a challenge to a draft or active challenge set.</DialogDescription>
          </DialogHeader>
          <ChallengeFormFields
            form={createForm}
            sets={sets}
            selectedSetId={selectedCreateSetId}
            mode="create"
            onChange={setCreateForm}
            onSubmit={submitCreate}
            onCancel={() => setCreateOpen(false)}
            submitting={createChallenge.isPending}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={(open) => setEditOpen(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit challenge</DialogTitle>
            <DialogDescription>Update scoring, copy, threshold, enabled state, or display order.</DialogDescription>
          </DialogHeader>
          <ChallengeFormFields
            form={editForm}
            sets={sets}
            selectedSetId={editForm.challenge_set_id}
            mode="edit"
            onChange={setEditForm}
            onSubmit={submitEdit}
            onCancel={() => setEditOpen(false)}
            submitting={updateChallenge.isPending}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={imageOpen} onOpenChange={(open) => setImageOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload target image</DialogTitle>
            <DialogDescription>
              Replace the target image for {imageChallenge?.title ?? "this challenge"}.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitImage}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="challenge-image">Image file</FieldLabel>
                <Input
                  id="challenge-image"
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
                />
                <FieldDescription>The backend stores this as the judging target image.</FieldDescription>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setImageOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={uploadImage.isPending}>
                  Upload image
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </div>
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
          <FieldLabel>Challenge set</FieldLabel>
          <Select
            items={sets.map((set) => ({ value: set.id, label: setLabel(set) }))}
            value={selectedSetId}
            onValueChange={(value) => onChange((current) => ({ ...current, challenge_set_id: String(value) }))}
            disabled={mode === "edit"}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a set" />
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
          <FieldLabel htmlFor={`${mode}-challenge-slug`}>Slug</FieldLabel>
          <Input
            id={`${mode}-challenge-slug`}
            required
            disabled={mode === "edit"}
            value={form.slug}
            onChange={(event) => onChange((current) => ({ ...current, slug: event.target.value }))}
            placeholder="draw-a-house"
          />
          <FieldDescription>Slugs are immutable after creation.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${mode}-challenge-title`}>Title</FieldLabel>
          <Input
            id={`${mode}-challenge-title`}
            required
            value={form.title}
            onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))}
            placeholder="Draw a house"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${mode}-challenge-description`}>Description</FieldLabel>
          <Textarea
            id={`${mode}-challenge-description`}
            required
            value={form.description}
            onChange={(event) => onChange((current) => ({ ...current, description: event.target.value }))}
            placeholder="Describe what teams should draw."
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-3">
          <Field>
            <FieldLabel htmlFor={`${mode}-challenge-points`}>Points</FieldLabel>
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
            <FieldLabel htmlFor={`${mode}-challenge-threshold`}>Pass threshold</FieldLabel>
            <Input
              id={`${mode}-challenge-threshold`}
              type="number"
              min="0"
              max="1"
              step="0.01"
              required
              value={form.pass_threshold}
              onChange={(event) => onChange((current) => ({ ...current, pass_threshold: event.target.value }))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${mode}-challenge-order`}>Order</FieldLabel>
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
            checked={form.enabled}
            onCheckedChange={(checked) => onChange((current) => ({ ...current, enabled: checked }))}
          />
          <div className="flex flex-col gap-1">
            <FieldLabel>Enabled</FieldLabel>
            <FieldDescription>Disabled challenges remain in admin views but are hidden from active play.</FieldDescription>
          </div>
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {mode === "create" ? "Create challenge" : "Save changes"}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  )
}
