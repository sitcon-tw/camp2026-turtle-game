import { useEffect, useRef } from "react"
import { type QueryKey, useQueryClient } from "@tanstack/react-query"

import { getTeamToken } from "@/lib/student/session"
import type { AppEvent } from "@/lib/student/types"

type InvalidationTarget = QueryKey | { queryKey: QueryKey; exact?: boolean }

type InvalidationInput = InvalidationTarget[] | ((event: AppEvent) => InvalidationTarget[] | void)

export type UseStudentEventsOptions = {
  enabled?: boolean
  token?: string | null
  invalidate?: InvalidationInput
  onEvent?: (event: AppEvent) => void
  onError?: (error: unknown) => void
}

export function useStudentEvents(options: UseStudentEventsOptions = {}) {
  const queryClient = useQueryClient()
  const token = options.token ?? getTeamToken()
  const enabled = options.enabled ?? true
  const invalidateRef = useRef(options.invalidate)
  const onEventRef = useRef(options.onEvent)
  const onErrorRef = useRef(options.onError)

  useEffect(() => {
    invalidateRef.current = options.invalidate
    onEventRef.current = options.onEvent
    onErrorRef.current = options.onError
  }, [options.invalidate, options.onError, options.onEvent])

  useEffect(() => {
    if (!enabled || !token) return

    const controller = new AbortController()
    let cancelled = false

    function invalidateFor(event: AppEvent) {
      const input = invalidateRef.current
      const targets = typeof input === "function" ? input(event) : input
      for (const target of targets ?? []) {
        if (isQueryKey(target)) {
          void queryClient.invalidateQueries({ queryKey: target })
        } else {
          void queryClient.invalidateQueries({ queryKey: target.queryKey, exact: target.exact })
        }
      }
    }

    function handleEvent(event: AppEvent) {
      onEventRef.current?.(event)
      invalidateFor(event)
    }

    async function connect() {
      try {
        const response = await fetch("/api/v1/events/team", {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`Student event stream failed with status ${response.status}`)
        }
        if (!response.body) {
          throw new Error("Student event stream is not readable")
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          buffer = consumeSseBuffer(buffer, handleEvent)
        }
        buffer += decoder.decode()
        consumeSseBuffer(`${buffer}\n\n`, handleEvent)
      } catch (error) {
        if (!controller.signal.aborted) onErrorRef.current?.(error)
      }
    }

    void connect()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled, queryClient, token])
}

function isQueryKey(target: InvalidationTarget): target is QueryKey {
  return Array.isArray(target)
}

function consumeSseBuffer(buffer: string, onEvent: (event: AppEvent) => void) {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const messages = normalized.split("\n\n")
  const remainder = messages.pop() ?? ""

  for (const message of messages) {
    const data = message
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) continue

    try {
      onEvent(JSON.parse(data) as AppEvent)
    } catch {
      // Ignore malformed SSE payloads and keep the stream alive.
    }
  }

  return remainder
}
