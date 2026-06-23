import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmAction } from "@/components/admin/AdminPrimitives"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { ScoreEventType, Team } from "@/lib/admin/types"

type ScoreTypeFilter = ScoreEventType | "all"
type ScoreOperation = "add" | "subtract" | "set"

const scoreTypeLabels: Record<ScoreEventType, string> = {
  challenge_pass: "Challenge pass",
  admin_add: "Admin add",
  admin_subtract: "Admin subtract",
  admin_set: "Admin set",
  admin_adjust: "Admin adjust",
  recalculation: "Recalculation",
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function teamName(teams: Team[], teamId: string) {
  return teams.find((team) => team.id === teamId)?.name ?? teamId
}

function numericValue(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export default function AdminScoresPage() {
  const queryClient = useQueryClient()
  const [teamFilter, setTeamFilter] = React.useState("all")
  const [typeFilter, setTypeFilter] = React.useState<ScoreTypeFilter>("all")
  const [selectedTeamIds, setSelectedTeamIds] = React.useState<string[]>([])
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [operation, setOperation] = React.useState<ScoreOperation>("add")
  const [amount, setAmount] = React.useState("0")
  const [reason, setReason] = React.useState("")
  const [actionError, setActionError] = React.useState<string | null>(null)

  const teamsQuery = useQuery({
    queryKey: ["admin", "teams", { enabled: null, search: "" }],
    queryFn: () => adminApi.teams({ enabled: null, search: "" }),
  })

  const eventsQuery = useQuery({
    queryKey: ["admin", "score-events", { teamFilter, typeFilter }],
    queryFn: () =>
      adminApi.scoreEvents({
        team_id: teamFilter === "all" ? undefined : teamFilter,
        type: typeFilter === "all" ? "" : typeFilter,
      }),
  })

  const invalidateScores = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "score-events"] })
    queryClient.invalidateQueries({ queryKey: ["admin", "teams"] })
  }

  const bulkAdjust = useMutation({
    mutationFn: () => {
      const value = numericValue(amount)
      const trimmedReason = reason.trim()

      if (operation === "set") {
        return adminApi.bulkAdjustScores({
          operation,
          team_ids: selectedTeamIds,
          target_score: value,
          reason: trimmedReason,
        })
      }

      return adminApi.bulkAdjustScores({
        operation,
        team_ids: selectedTeamIds,
        amount: value,
        reason: trimmedReason,
      })
    },
    onSuccess: () => {
      setBulkOpen(false)
      setReason("")
      setActionError(null)
      invalidateScores()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const recalculateScores = useMutation({
    mutationFn: () => adminApi.recalculateScores(),
    onSuccess: () => invalidateScores(),
    onError: (error) => setActionError(errorMessage(error)),
  })

  const recalculateAwards = useMutation({
    mutationFn: () => adminApi.recalculateChallengeAwards(),
    onSuccess: () => invalidateScores(),
    onError: (error) => setActionError(errorMessage(error)),
  })

  const teams = teamsQuery.data ?? []
  const enabledTeams = teams.filter((team) => team.enabled)
  const events = eventsQuery.data ?? []
  const allSelected = enabledTeams.length > 0 && selectedTeamIds.length === enabledTeams.length
  const hasBulkInput = selectedTeamIds.length > 0 && reason.trim() && Number.isFinite(Number(amount))

  function toggleTeam(teamId: string, checked: boolean) {
    setSelectedTeamIds((current) =>
      checked ? Array.from(new Set([...current, teamId])) : current.filter((id) => id !== teamId),
    )
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Scores</h1>
          <p className="text-sm text-muted-foreground">
            Review score events, bulk adjust team totals, and trigger score recalculations.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ConfirmAction
            title="Recalculate challenge awards"
            description="Recalculate challenge awards from submission results?"
            confirmLabel="Recalculate"
            disabled={recalculateAwards.isPending}
            onConfirm={() => recalculateAwards.mutate()}
          >
            <Button variant="outline">Recalculate awards</Button>
          </ConfirmAction>
          <ConfirmAction
            title="Recalculate scores"
            description="Recalculate every team score from score events?"
            confirmLabel="Recalculate"
            disabled={recalculateScores.isPending}
            onConfirm={() => recalculateScores.mutate()}
          >
            <Button variant="outline">Recalculate scores</Button>
          </ConfirmAction>
          <Button disabled={selectedTeamIds.length === 0} onClick={() => setBulkOpen(true)}>
            Bulk adjust
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Score events shown</CardDescription>
            <CardTitle className="text-2xl">{events.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Selected teams</CardDescription>
            <CardTitle className="text-2xl">{selectedTeamIds.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Visible delta</CardDescription>
            <CardTitle className="text-2xl">
              {events.reduce((sum, event) => sum + event.delta, 0)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Bulk target teams</CardTitle>
            <CardDescription>Select enabled teams before applying add, subtract, or set operations.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(checked) => {
                  setSelectedTeamIds(checked ? enabledTeams.map((team) => team.id) : [])
                }}
              />
              Select all enabled teams
            </label>
            <div className="grid max-h-96 gap-2 overflow-auto pr-1">
              {teamsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading teams...</p>
              ) : enabledTeams.length === 0 ? (
                <p className="text-sm text-muted-foreground">No enabled teams are available.</p>
              ) : (
                enabledTeams.map((team) => (
                  <label
                    key={team.id}
                    className="flex items-center justify-between gap-3 rounded-lg border p-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedTeamIds.includes(team.id)}
                        onCheckedChange={(checked) => toggleTeam(team.id, Boolean(checked))}
                      />
                      <span>{team.name}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{team.total_score}</span>
                  </label>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Score events</CardTitle>
            <CardDescription>Filter by team and event type.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select items={[{ value: "all", label: "All teams" }, ...teams.map((team) => ({ value: team.id, label: team.name }))]} value={teamFilter} onValueChange={(value) => setTeamFilter(String(value))}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All teams</SelectItem>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select items={[{ value: "all", label: "All event types" }, ...Object.entries(scoreTypeLabels).map(([value, label]) => ({ value, label }))]} value={typeFilter} onValueChange={(value) => setTypeFilter(value as ScoreTypeFilter)}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All event types</SelectItem>
                  {Object.entries(scoreTypeLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}
            {eventsQuery.isError ? <p className="text-sm text-destructive">{errorMessage(eventsQuery.error)}</p> : null}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Before</TableHead>
                  <TableHead className="text-right">Delta</TableHead>
                  <TableHead className="text-right">After</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventsQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      Loading score events...
                    </TableCell>
                  </TableRow>
                ) : events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      No score events match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>{formatDate(event.created_at)}</TableCell>
                      <TableCell>{teamName(teams, event.team_id)}</TableCell>
                      <TableCell>
                        <Badge variant={event.type.startsWith("admin") ? "secondary" : "outline"}>
                          {scoreTypeLabels[event.type]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{event.score_before}</TableCell>
                      <TableCell className={event.delta < 0 ? "text-right text-destructive" : "text-right"}>
                        {event.delta > 0 ? `+${event.delta}` : event.delta}
                      </TableCell>
                      <TableCell className="text-right font-medium">{event.score_after}</TableCell>
                      <TableCell>
                        <div className="max-w-80 truncate">{event.reason ?? "No reason"}</div>
                        {event.created_by ? (
                          <div className="text-xs text-muted-foreground">by {event.created_by}</div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Bulk adjust scores</DialogTitle>
            <DialogDescription>
              Applies to {selectedTeamIds.length} selected team{selectedTeamIds.length === 1 ? "" : "s"} and creates audit score events.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium">
              Operation
              <Select items={[{ value: "add", label: "Add points" }, { value: "subtract", label: "Subtract points" }, { value: "set", label: "Set total score" }]} value={operation} onValueChange={(value) => setOperation(value as ScoreOperation)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">Add points</SelectItem>
                  <SelectItem value="subtract">Subtract points</SelectItem>
                  <SelectItem value="set">Set total score</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {operation === "set" ? "Target score" : "Amount"}
              <Input
                type="number"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                min={0}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Reason
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Required audit note"
              />
            </label>
            {bulkAdjust.isError ? <p className="text-sm text-destructive">{errorMessage(bulkAdjust.error)}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <ConfirmAction
              title="Apply score adjustment"
              description={`Apply ${operation} operation to ${selectedTeamIds.length} teams?`}
              confirmLabel={bulkAdjust.isPending ? "Applying..." : "Apply adjustment"}
              disabled={bulkAdjust.isPending || !hasBulkInput}
              onConfirm={() => bulkAdjust.mutate()}
            >
              <Button>Apply adjustment</Button>
            </ConfirmAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
