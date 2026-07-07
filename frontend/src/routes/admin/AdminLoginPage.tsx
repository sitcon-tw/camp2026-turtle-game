import { useState } from "react"
import type { FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { ArrowLeftIcon, Loader2Icon, LockKeyholeIcon, TurtleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { adminApi, errorMessage } from "@/lib/admin/api"
import { setAdminToken } from "@/lib/admin/session"

type LocationState = {
  from?: {
    pathname?: string
  }
}

export default function AdminLoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      const response = await adminApi.login(password)
      setAdminToken(response.access_token)
      const state = location.state as LocationState | null
      navigate(state?.from?.pathname ?? "/admin", { replace: true })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-svh bg-paper px-4 py-8 text-ink">
      <div className="mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-md flex-col justify-center">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-[1rem] border-2 border-ink bg-primary text-primary-foreground shadow-[2px_2px_0_rgba(23,35,58,0.16)]">
              <TurtleIcon className="size-6" />
            </div>
            <CardTitle className="text-2xl">管理員登入</CardTitle>
            <CardDescription>使用管理員密碼開啟指揮中心。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="admin-password">管理員密碼</FieldLabel>
                  <Input
                    id="admin-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="輸入密碼"
                    aria-invalid={Boolean(error)}
                    disabled={submitting}
                    required
                  />
                  {error ? <FieldError>{error}</FieldError> : <FieldDescription>登入狀態會儲存在這台瀏覽器本機。</FieldDescription>}
                </Field>
                <Button type="submit" size="lg" disabled={submitting || !password}>
                  {submitting ? <Loader2Icon className="animate-spin" /> : <LockKeyholeIcon />}
                  登入
                </Button>
                <Button type="button" variant="ghost" nativeButton={false} render={<Link to="/" />}>
                  <ArrowLeftIcon /> 返回遊戲
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
