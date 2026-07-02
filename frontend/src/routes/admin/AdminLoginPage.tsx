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
    <main className="min-h-svh bg-background px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100svh-4rem)] w-full max-w-md flex-col justify-center">
        <Card className="shadow-xl shadow-foreground/5">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
              <TurtleIcon className="size-6" />
            </div>
            <CardTitle className="text-2xl">Admin sign in</CardTitle>
            <CardDescription>Use the admin password to open the command center.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="admin-password">Admin password</FieldLabel>
                  <Input
                    id="admin-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter password"
                    aria-invalid={Boolean(error)}
                    disabled={submitting}
                    required
                  />
                  {error ? <FieldError>{error}</FieldError> : <FieldDescription>Session tokens are stored locally in this browser.</FieldDescription>}
                </Field>
                <Button type="submit" size="lg" disabled={submitting || !password}>
                  {submitting ? <Loader2Icon className="animate-spin" /> : <LockKeyholeIcon />}
                  Sign in
                </Button>
                <Button type="button" variant="ghost" nativeButton={false} render={<Link to="/" />}>
                  <ArrowLeftIcon /> Back to game
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
