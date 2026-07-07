import * as React from "react"
import { AlertTriangleIcon, CheckCircle2Icon, CircleIcon, Loader2Icon, SearchXIcon, XCircleIcon } from "lucide-react"

import { AdminApiError, errorMessage } from "@/lib/admin/api"
import { cn } from "@/lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table } from "@/components/ui/table"

type StatusTone = "neutral" | "success" | "warning" | "danger" | "info"

const statusTone: Record<string, StatusTone> = {
  active: "success",
  archived: "neutral",
  cancelled: "neutral",
  completed: "success",
  disabled: "danger",
  draft: "warning",
  enabled: "success",
  failed: "danger",
  idle: "neutral",
  paused: "warning",
  queued: "info",
  running: "info",
}

const toneVariant: Record<StatusTone, React.ComponentProps<typeof Badge>["variant"]> = {
  danger: "destructive",
  info: "secondary",
  neutral: "outline",
  success: "secondary",
  warning: "outline",
}

function humanizeStatus(status: string | boolean | null | undefined) {
  if (typeof status === "boolean") return status ? "Enabled" : "Disabled"
  if (!status) return "Unknown"
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function toneForStatus(status: string | boolean | null | undefined, tone?: StatusTone) {
  if (tone) return tone
  if (typeof status === "boolean") return status ? "success" : "danger"
  return status ? statusTone[status.toLowerCase()] ?? "neutral" : "neutral"
}

export function StatusBadge({
  status,
  tone,
  className,
}: {
  status: string | boolean | null | undefined
  tone?: StatusTone
  className?: string
}) {
  const resolvedTone = toneForStatus(status, tone)

  return (
    <Badge variant={toneVariant[resolvedTone]} className={cn("capitalize", className)}>
      {humanizeStatus(status)}
    </Badge>
  )
}

export function JsonBlock({
  value,
  title,
  className,
}: {
  value: unknown
  title?: string
  className?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-muted/30", className)}>
      {title ? <div className="border-b px-3 py-2 text-sm font-medium">{title}</div> : null}
      <pre className="max-h-96 overflow-auto p-3 text-xs leading-relaxed text-muted-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

export function ConfirmAction({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  disabled = false,
  onConfirm,
  children,
}: {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  disabled?: boolean
  onConfirm: () => void | Promise<void>
  children: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [isConfirming, setIsConfirming] = React.useState(false)
  const isDisabled = disabled || isConfirming

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger disabled={isDisabled} render={children} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isConfirming}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={isDisabled}
            onClick={async () => {
              setIsConfirming(true)
              try {
                await onConfirm()
                setOpen(false)
              } finally {
                setIsConfirming(false)
              }
            }}
          >
            {isConfirming ? "Working..." : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function LoadingState({
  title = "Loading admin data",
  description = "Fetching the latest state from the server.",
  rows = 3,
}: {
  title?: string
  description?: string
  rows?: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Loader2Icon className="size-4 animate-spin" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

export function ErrorState({
  error,
  title = "Something went wrong",
  action,
}: {
  error: unknown
  title?: string
  action?: React.ReactNode
}) {
  const apiCode = error instanceof AdminApiError ? error.code : null

  return (
    <Empty className="border border-destructive/20 bg-destructive/5">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-destructive">
          <XCircleIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{errorMessage(error)}</EmptyDescription>
      </EmptyHeader>
      {apiCode || action ? (
        <EmptyContent>
          {apiCode ? <StatusBadge status={apiCode} tone="danger" /> : null}
          {action}
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

export function EmptyState({
  title = "No records found",
  description = "There is nothing to show yet.",
  action,
}: {
  title?: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}

export function TableShell({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>{children}</Table>
      </CardContent>
    </Card>
  )
}

export function AdminHealthPill({ ok }: { ok: boolean | null }) {
  if (ok === null) return <StatusBadge status="unknown" tone="neutral" />
  return ok ? (
    <Badge variant="secondary">
      <CheckCircle2Icon /> Online
    </Badge>
  ) : (
    <Badge variant="destructive">
      <AlertTriangleIcon /> Offline
    </Badge>
  )
}

export function MutedDotLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <CircleIcon className="size-2 fill-current" />
      {children}
    </span>
  )
}

export { Button }
