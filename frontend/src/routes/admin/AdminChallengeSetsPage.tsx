import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArchiveIcon,
  DownloadIcon,
  FileUpIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"

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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { ChallengeSet } from "@/lib/admin/types"

const challengeSetsQueryKey = ["admin", "challenge-sets"] as const

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

export default function AdminChallengeSetsPage() {
  const queryClient = useQueryClient()
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [createForm, setCreateForm] = useState({ name: "", version: "" })
  const [importFile, setImportFile] = useState<File | null>(null)

  const setsQuery = useQuery({
    queryKey: challengeSetsQueryKey,
    queryFn: adminApi.challengeSets,
  })

  const createSet = useMutation({
    mutationFn: adminApi.createChallengeSet,
    onSuccess: (set) => {
      toast.success(`Created ${set.name}`)
      setCreateForm({ name: "", version: "" })
      setCreateOpen(false)
      void queryClient.invalidateQueries({ queryKey: challengeSetsQueryKey })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const importSet = useMutation({
    mutationFn: adminApi.importChallengeSet,
    onSuccess: (set) => {
      toast.success(`Imported ${set.name}`)
      setImportFile(null)
      if (importInputRef.current) importInputRef.current.value = ""
      setImportOpen(false)
      void queryClient.invalidateQueries({ queryKey: challengeSetsQueryKey })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const activateSet = useMutation({
    mutationFn: adminApi.activateChallengeSet,
    onSuccess: (set) => {
      toast.success(`Activated ${set.name}`)
      void queryClient.invalidateQueries({ queryKey: challengeSetsQueryKey })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const archiveSet = useMutation({
    mutationFn: adminApi.archiveChallengeSet,
    onSuccess: (set) => {
      toast.success(`Archived ${set.name}`)
      void queryClient.invalidateQueries({ queryKey: challengeSetsQueryKey })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const exportSet = useMutation({
    mutationFn: async (set: ChallengeSet) => ({
      blob: await adminApi.exportChallengeSet(set.id),
      set,
    }),
    onSuccess: ({ blob, set }) => {
      downloadBlob(blob, `${set.name}-${set.version}.zip`)
      toast.success(`Exported ${set.name}`)
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  const sets = setsQuery.data ?? []

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    createSet.mutate({
      name: createForm.name.trim(),
      version: createForm.version.trim(),
    })
  }

  function submitImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!importFile) {
      toast.error("Choose a challenge set archive to import.")
      return
    }
    importSet.mutate(importFile)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Challenge sets</h1>
          <p className="text-sm text-muted-foreground">
            Create, import, export, activate, and archive challenge set versions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void setsQuery.refetch()} disabled={setsQuery.isFetching}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <FileUpIcon data-icon="inline-start" />
            Import
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            New set
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
          <CardDescription>{sets.length} challenge set records</CardDescription>
          <CardAction>
            {sets.some((set) => set.status === "active") ? (
              <Badge>Active set configured</Badge>
            ) : (
              <Badge variant="outline">No active set</Badge>
            )}
          </CardAction>
        </CardHeader>
        <CardContent>
          {setsQuery.isLoading ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RefreshCwIcon />
                </EmptyMedia>
                <EmptyTitle>Loading challenge sets</EmptyTitle>
                <EmptyDescription>Fetching the current admin challenge set list.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : setsQuery.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Challenge sets could not be loaded</EmptyTitle>
                <EmptyDescription>{errorMessage(setsQuery.error)}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => void setsQuery.refetch()}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Try again
                </Button>
              </EmptyContent>
            </Empty>
          ) : sets.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlusIcon />
                </EmptyMedia>
                <EmptyTitle>No challenge sets yet</EmptyTitle>
                <EmptyDescription>Create a draft set or import one from an archive.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setCreateOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  Create challenge set
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Challenges</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sets.map((set) => (
                  <TableRow key={set.id}>
                    <TableCell className="font-medium">{set.name}</TableCell>
                    <TableCell>{set.version}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(set.status)}>{set.status}</Badge>
                    </TableCell>
                    <TableCell>{set.challenge_count ?? 0}</TableCell>
                    <TableCell>{formatDate(set.updated_at)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => exportSet.mutate(set)}
                          disabled={exportSet.isPending}
                        >
                          <DownloadIcon data-icon="inline-start" />
                          Export
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => activateSet.mutate(set.id)}
                          disabled={set.status === "active" || activateSet.isPending}
                        >
                          <PlayIcon data-icon="inline-start" />
                          Activate
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => archiveSet.mutate(set.id)}
                          disabled={set.status === "archived" || archiveSet.isPending}
                        >
                          <ArchiveIcon data-icon="inline-start" />
                          Archive
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create challenge set</DialogTitle>
            <DialogDescription>Add a draft version that can receive challenges before activation.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitCreate}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="challenge-set-name">Name</FieldLabel>
                <Input
                  id="challenge-set-name"
                  required
                  value={createForm.name}
                  onChange={(event) => setCreateForm((form) => ({ ...form, name: event.target.value }))}
                  placeholder="Spring finals"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="challenge-set-version">Version</FieldLabel>
                <Input
                  id="challenge-set-version"
                  required
                  value={createForm.version}
                  onChange={(event) => setCreateForm((form) => ({ ...form, version: event.target.value }))}
                  placeholder="2026.1"
                />
                <FieldDescription>Use a stable version label for exports and audit history.</FieldDescription>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createSet.isPending}>
                  Create set
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={(open) => setImportOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import challenge set</DialogTitle>
            <DialogDescription>Upload an exported challenge set archive.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitImport}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="challenge-set-import">Archive</FieldLabel>
                <Input
                  id="challenge-set-import"
                  ref={importInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
                />
                <FieldDescription>Imported sets are added as their own version record.</FieldDescription>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setImportOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={importSet.isPending}>
                  Import set
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
