import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PencilIcon, PowerIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"

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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { adminApi, errorMessage } from "@/lib/admin/api"
import type { Team } from "@/lib/admin/types"
import { normalizeLoginCodeInput } from "@/lib/login-code"

type EnabledFilter = "all" | "enabled" | "disabled"

type TeamForm = {
  name: string
  login_code: string
  note: string
}

type ScoreForm = {
  target_score: string
  reason: string
}

const emptyTeamForm: TeamForm = {
  name: "",
  login_code: "",
  note: "",
}

const defaultScoreReason = "Manual score correction"
const resetAllScoresReason = "Reset all team scores from admin teams page"

function enabledParam(filter: EnabledFilter) {
  if (filter === "enabled") return true
  if (filter === "disabled") return false
  return null
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function parseBulkTeams(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", login_code = "", ...noteParts] = line
        .split(/[\t,]/)
        .map((part) => part.trim())

      return {
        name,
        login_code: login_code ? normalizeLoginCodeInput(login_code) : undefined,
        note: noteParts.join(", ") || undefined,
      }
    })
    .filter((team) => team.name)
}

function parseScoreInput(value: string) {
  const score = Number(value)
  if (!Number.isInteger(score) || score < 0) return null
  return score
}

function TeamDialog({
  mode,
  open,
  initialValue,
  isSaving,
  error,
  onOpenChange,
  onSubmit,
}: {
  mode: "create" | "edit"
  open: boolean
  initialValue: TeamForm
  isSaving: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (value: TeamForm) => void
}) {
  const [form, setForm] = React.useState<TeamForm>(initialValue)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "新增隊伍" : "編輯隊伍"}</DialogTitle>
          <DialogDescription>
            隊伍名稱會顯示在排行榜上。隊伍登入碼可手動提供，也可由伺服器產生。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(form)
          }}
        >
          <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${mode}-team-name`}>隊伍名稱</FieldLabel>
            <Input
              id={`${mode}-team-name`}
              required
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="綠隊"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${mode}-team-login-code`}>隊伍登入碼</FieldLabel>
            <Input
              id={`${mode}-team-login-code`}
              value={form.login_code}
              onChange={(event) =>
                setForm((current) => ({ ...current, login_code: normalizeLoginCodeInput(event.target.value) }))
              }
              placeholder={mode === "create" ? "留空則自動產生" : "目前的隊伍登入碼"}
              autoCapitalize="characters"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${mode}-team-note`}>備註</FieldLabel>
            <Textarea
              id={`${mode}-team-note`}
              value={form.note}
              onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              placeholder="內部管理備註"
            />
          </Field>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={isSaving || !form.name.trim()}>
              {isSaving ? "儲存中..." : mode === "create" ? "新增隊伍" : "儲存變更"}
            </Button>
          </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ScoreDialog({
  open,
  team,
  isSaving,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  team: Team
  isSaving: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (value: ScoreForm) => void
}) {
  const [form, setForm] = React.useState<ScoreForm>({
    target_score: String(team.total_score),
    reason: defaultScoreReason,
  })
  const parsedScore = parseScoreInput(form.target_score)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>編輯隊伍分數</DialogTitle>
          <DialogDescription>
            將 {team.name} 的總分設定為指定分數，並留下分數調整紀錄。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (parsedScore === null || !form.reason.trim()) return
            onSubmit(form)
          }}
        >
          <FieldGroup>
            <Field data-invalid={parsedScore === null}>
              <FieldLabel htmlFor="team-score-target">總分</FieldLabel>
              <Input
                id="team-score-target"
                type="number"
                min="0"
                step="1"
                required
                aria-invalid={parsedScore === null}
                value={form.target_score}
                onChange={(event) => setForm((current) => ({ ...current, target_score: event.target.value }))}
              />
              <FieldDescription>目前分數：{team.total_score}</FieldDescription>
            </Field>
            <Field data-invalid={!form.reason.trim()}>
              <FieldLabel htmlFor="team-score-reason">原因</FieldLabel>
              <Textarea
                id="team-score-reason"
                required
                aria-invalid={!form.reason.trim()}
                value={form.reason}
                onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
              />
            </Field>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" disabled={isSaving || parsedScore === null || !form.reason.trim()}>
                {isSaving ? "儲存中..." : "儲存分數"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function AdminTeamsPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = React.useState("")
  const [enabled, setEnabled] = React.useState<EnabledFilter>("all")
  const [createOpen, setCreateOpen] = React.useState(false)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [bulkText, setBulkText] = React.useState("")
  const [editingTeam, setEditingTeam] = React.useState<Team | null>(null)
  const [editingScoreTeam, setEditingScoreTeam] = React.useState<Team | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const teamsQuery = useQuery({
    queryKey: ["admin", "teams", { enabled, search }],
    queryFn: () => adminApi.teams({ enabled: enabledParam(enabled), search }),
  })

  const invalidateScoreViews = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "teams"] })
    void queryClient.invalidateQueries({ queryKey: ["leaderboard"] })
    void queryClient.invalidateQueries({ queryKey: ["public", "blackboard"] })
  }

  const invalidateTeams = () => queryClient.invalidateQueries({ queryKey: ["admin", "teams"] })

  const createTeam = useMutation({
    mutationFn: (form: TeamForm) =>
      adminApi.createTeam({
        name: form.name.trim(),
        login_code: normalizeLoginCodeInput(form.login_code).trim() || undefined,
        note: form.note.trim() || undefined,
      }),
    onSuccess: () => {
      setCreateOpen(false)
      setActionError(null)
      invalidateTeams()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const bulkCreate = useMutation({
    mutationFn: (value: string) => adminApi.bulkCreateTeams(parseBulkTeams(value)),
    onSuccess: () => {
      setBulkOpen(false)
      setBulkText("")
      setActionError(null)
      invalidateTeams()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const updateTeam = useMutation({
    mutationFn: ({ id, form }: { id: string; form: TeamForm }) =>
      adminApi.updateTeam(id, {
        name: form.name.trim(),
        login_code: normalizeLoginCodeInput(form.login_code).trim(),
        note: form.note.trim() || null,
      }),
    onSuccess: () => {
      setEditingTeam(null)
      setActionError(null)
      invalidateTeams()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const rotateCode = useMutation({
    mutationFn: (team: Team) => adminApi.rotateTeamCode(team.id),
    onSuccess: () => {
      setActionError(null)
      invalidateTeams()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const setTeamEnabled = useMutation({
    mutationFn: (team: Team) => (team.enabled ? adminApi.disableTeam(team.id) : adminApi.enableTeam(team.id)),
    onSuccess: () => {
      setActionError(null)
      invalidateTeams()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const deleteTeam = useMutation({
    mutationFn: (team: Team) => adminApi.deleteTeam(team.id),
    onSuccess: () => {
      setActionError(null)
      invalidateTeams()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const setTeamScore = useMutation({
    mutationFn: ({ team, form }: { team: Team; form: ScoreForm }) => {
      const targetScore = parseScoreInput(form.target_score)
      if (targetScore === null) throw new Error("Score must be a non-negative integer")
      return adminApi.setTeamScores({
        team_ids: [team.id],
        target_score: targetScore,
        reason: form.reason.trim(),
      })
    },
    onSuccess: () => {
      setEditingScoreTeam(null)
      setActionError(null)
      invalidateScoreViews()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const resetAllScores = useMutation({
    mutationFn: async () => {
      const allTeams = await adminApi.teams({ enabled: null, search: "" })
      if (allTeams.length === 0) return { updated_teams: [] }
      return adminApi.setTeamScores({
        team_ids: allTeams.map((team) => team.id),
        target_score: 0,
        reason: resetAllScoresReason,
      })
    },
    onSuccess: () => {
      setActionError(null)
      invalidateScoreViews()
    },
    onError: (error) => setActionError(errorMessage(error)),
  })

  const teams = teamsQuery.data ?? []
  const activeCount = teams.filter((team) => team.enabled).length
  const parsedBulkCount = parseBulkTeams(bulkText).length

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">隊伍</h1>
          <p className="text-sm text-muted-foreground">
            搜尋、新增、批次新增、編輯、重設登入代碼、啟用或停用隊伍與刪除隊伍。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ConfirmAction
            title="重設所有隊伍分數"
            description="要將所有隊伍的總分重設為 0 嗎？此操作會寫入分數調整紀錄，且不受目前搜尋或篩選條件限制。"
            confirmLabel="重設分數"
            destructive
            disabled={resetAllScores.isPending}
            onConfirm={async () => {
              await resetAllScores.mutateAsync()
            }}
          >
            <Button variant="outline">
              <RotateCcwIcon data-icon="inline-start" />
              重設全部分數
            </Button>
          </ConfirmAction>
          <Button
            variant="outline"
            onClick={() => {
              bulkCreate.reset()
              setBulkText("")
              setBulkOpen(true)
            }}
          >
            批次新增
          </Button>
          <Button
            onClick={() => {
              createTeam.reset()
              setCreateOpen(true)
            }}
          >
            新增隊伍
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>目前顯示隊伍</CardDescription>
            <CardTitle className="text-2xl">{teams.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>目前顯示的已啟用隊伍</CardDescription>
            <CardTitle className="text-2xl">{activeCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>總分合計</CardDescription>
            <CardTitle className="text-2xl">
              {teams.reduce((sum, team) => sum + team.total_score, 0)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>隊伍清單</CardTitle>
          <CardDescription>篩選條件會套用到隊伍清單。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <FieldLabel htmlFor="team-search" className="sr-only">
              搜尋隊伍名稱或隊伍登入碼
            </FieldLabel>
            <Input
              id="team-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋隊伍名稱或隊伍登入碼"
              className="sm:max-w-sm"
            />
            <Select items={[{ value: "all", label: "所有隊伍" }, { value: "enabled", label: "已啟用" }, { value: "disabled", label: "已停用" }]} value={enabled} onValueChange={(value) => setEnabled(value as EnabledFilter)}>
              <SelectTrigger aria-label="依狀態篩選隊伍" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">所有隊伍</SelectItem>
                <SelectItem value="enabled">已啟用</SelectItem>
                <SelectItem value="disabled">已停用</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          {teamsQuery.isError ? <p role="alert" className="text-sm text-destructive">{errorMessage(teamsQuery.error)}</p> : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名稱</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>隊伍登入碼</TableHead>
                <TableHead className="text-right">分數</TableHead>
                <TableHead>更新時間</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teamsQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    載入隊伍中...
                  </TableCell>
                </TableRow>
              ) : teams.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    沒有符合目前篩選條件的隊伍。
                  </TableCell>
                </TableRow>
              ) : (
                teams.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell>
                      <div className="font-medium">{team.name}</div>
                      {team.note ? <div className="max-w-72 truncate text-xs text-muted-foreground">{team.note}</div> : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={team.enabled ? "secondary" : "outline"}>
                        {team.enabled ? "已啟用" : "已停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{team.login_code}</TableCell>
                    <TableCell className="text-right font-medium">{team.total_score}</TableCell>
                    <TableCell>{formatDate(team.updated_at)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            updateTeam.reset()
                            setEditingTeam(team)
                          }}
                        >
                          <PencilIcon data-icon="inline-start" />
                          編輯
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setTeamScore.reset()
                            setEditingScoreTeam(team)
                          }}
                        >
                          <PencilIcon data-icon="inline-start" />
                          編輯分數
                        </Button>
                        <ConfirmAction
                          title="重新產生隊伍登入碼"
                          description={`要重新產生 ${team.name} 的隊伍登入碼嗎？舊登入碼將無法再使用。`}
                          confirmLabel="重新產生"
                          disabled={rotateCode.isPending}
                          onConfirm={() => rotateCode.mutate(team)}
                        >
                          <Button variant="outline" size="sm">
                            <RotateCcwIcon data-icon="inline-start" />
                            重新產生
                          </Button>
                        </ConfirmAction>
                        <ConfirmAction
                          title={team.enabled ? "停用隊伍" : "啟用隊伍"}
                          description={
                            team.enabled
                              ? `${team.name} 在重新啟用前將無法登入、提交或投票。`
                              : `${team.name} 將可以再次登入、提交與投票。`
                          }
                          confirmLabel={team.enabled ? "停用" : "啟用"}
                          destructive={team.enabled}
                          disabled={setTeamEnabled.isPending}
                          onConfirm={() => setTeamEnabled.mutate(team)}
                        >
                          <Button variant={team.enabled ? "outline" : "default"} size="sm">
                            <PowerIcon data-icon="inline-start" />
                            {team.enabled ? "停用" : "啟用"}
                          </Button>
                        </ConfirmAction>
                        <ConfirmAction
                          title="永久刪除隊伍"
                          description={`${team.name} 及其提交內容、分數和進行中遊戲的相關資料將被永久刪除。`}
                          confirmLabel="永久刪除"
                          destructive
                          disabled={deleteTeam.isPending}
                          onConfirm={() => deleteTeam.mutate(team)}
                        >
                          <Button variant="destructive" size="sm">
                            <Trash2Icon data-icon="inline-start" />
                            刪除
                          </Button>
                        </ConfirmAction>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {createOpen ? (
        <TeamDialog
          mode="create"
          open={createOpen}
          initialValue={emptyTeamForm}
          isSaving={createTeam.isPending}
          error={createTeam.isError ? errorMessage(createTeam.error) : null}
          onOpenChange={(open) => {
            setCreateOpen(open)
            setActionError(null)
            if (!open) createTeam.reset()
          }}
          onSubmit={(form) => createTeam.mutate(form)}
        />
      ) : null}

      {editingTeam ? (
        <TeamDialog
          key={editingTeam.id}
          mode="edit"
          open={editingTeam !== null}
          initialValue={{
            name: editingTeam.name,
            login_code: editingTeam.login_code,
            note: editingTeam.note ?? "",
          }}
          isSaving={updateTeam.isPending}
          error={updateTeam.isError ? errorMessage(updateTeam.error) : null}
          onOpenChange={(open) => {
            if (!open) setEditingTeam(null)
            setActionError(null)
            if (!open) updateTeam.reset()
          }}
          onSubmit={(form) => {
            updateTeam.mutate({ id: editingTeam.id, form })
          }}
        />
      ) : null}

      {editingScoreTeam ? (
        <ScoreDialog
          key={editingScoreTeam.id}
          open={editingScoreTeam !== null}
          team={editingScoreTeam}
          isSaving={setTeamScore.isPending}
          error={setTeamScore.isError ? errorMessage(setTeamScore.error) : null}
          onOpenChange={(open) => {
            if (!open) setEditingScoreTeam(null)
            setActionError(null)
            if (!open) setTeamScore.reset()
          }}
          onSubmit={(form) => {
            setTeamScore.mutate({ team: editingScoreTeam, form })
          }}
        />
      ) : null}

      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          setBulkOpen(open)
          if (!open) {
            setBulkText("")
            bulkCreate.reset()
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>批次新增隊伍</DialogTitle>
            <DialogDescription>
              每行新增一個隊伍。使用逗號或 Tab 字元分隔欄位：名稱、選填隊伍登入碼、選填備註。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <FieldLabel htmlFor="bulk-team-rows" className="sr-only">
              批次隊伍列
            </FieldLabel>
            <Textarea
              id="bulk-team-rows"
              value={bulkText}
              onChange={(event) => setBulkText(event.target.value)}
              className="min-h-56 font-mono"
              placeholder={"綠隊,GT-102,教練：林\n藍隊\n紅隊,RED-7"}
            />
            <p className="text-sm text-muted-foreground">已解析 {parsedBulkCount} 個有效隊伍。</p>
            {bulkCreate.isError ? <p role="alert" className="text-sm text-destructive">{errorMessage(bulkCreate.error)}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              取消
            </Button>
            <Button
              disabled={bulkCreate.isPending || parsedBulkCount === 0}
              onClick={() => bulkCreate.mutate(bulkText)}
            >
              {bulkCreate.isPending ? "新增中..." : "新增隊伍"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
