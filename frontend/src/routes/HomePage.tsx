import { Link } from "react-router-dom"
import { ArrowRightIcon, ShieldIcon, TurtleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function HomePage() {
  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_20%_20%,var(--muted),transparent_28rem),linear-gradient(160deg,var(--background),var(--muted))] p-6">
      <div className="mx-auto flex min-h-[calc(100svh-3rem)] max-w-5xl items-center">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <section className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-sm text-muted-foreground backdrop-blur">
              <TurtleIcon className="size-4" />
              Turtle drawing challenge
            </div>
            <div className="space-y-4">
              <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">Build, judge, and score turtle programs.</h1>
              <p className="max-w-2xl text-lg text-muted-foreground">
                The game frontend is ready for player flows, and the admin console is available for operations.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button size="lg" render={<Link to="/admin" />}>
                Open admin <ArrowRightIcon />
              </Button>
              <Button size="lg" variant="outline" render={<Link to="/admin/login" />}>
                Admin login
              </Button>
            </div>
          </section>
          <Card className="bg-background/75 backdrop-blur">
            <CardHeader>
              <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <ShieldIcon className="size-5" />
              </div>
              <CardTitle>Admin console</CardTitle>
              <CardDescription>Manage teams, challenge sets, queue state, submissions, and scoring from one protected shell.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm text-muted-foreground">
              <p>Use the admin password to start a local browser session.</p>
              <p>Navigation is grouped by operational workflow so feature pages can plug into the shell.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
