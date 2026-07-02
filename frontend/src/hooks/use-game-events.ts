import { useEffect, useRef, useState } from "react"

import type { GameStateResponse } from "@/lib/game/types"

export type GameEventConnectionState = "idle" | "connecting" | "open" | "error"

export type UseGameEventsOptions = {
  enabled?: boolean
  token: string | null
  onSnapshot: (snapshot: GameStateResponse) => void
  onError?: (error: unknown) => void
}

export function useGameEvents({ enabled = true, token, onSnapshot, onError }: UseGameEventsOptions) {
  const [connectionState, setConnectionState] = useState<GameEventConnectionState>("idle")
  const onSnapshotRef = useRef(onSnapshot)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onSnapshotRef.current = onSnapshot
    onErrorRef.current = onError
  }, [onError, onSnapshot])

  useEffect(() => {
    if (!enabled || !token) {
      window.setTimeout(() => setConnectionState("idle"), 0)
      return
    }

    const controller = new AbortController()
    let cancelled = false

    async function connect() {
      setConnectionState("connecting")
      try {
        const response = await fetch("/api/v1/game/events", {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Game event stream failed with status ${response.status}`)
        if (!response.body) throw new Error("Game event stream is not readable")

        setConnectionState("open")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          buffer = consumeSseBuffer(buffer, onSnapshotRef.current)
        }
        buffer += decoder.decode()
        consumeSseBuffer(`${buffer}\n\n`, onSnapshotRef.current)
      } catch (error) {
        if (!controller.signal.aborted) {
          setConnectionState("error")
          onErrorRef.current?.(error)
        }
      }
    }

    void connect()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled, token])

  return connectionState
}

function consumeSseBuffer(buffer: string, onSnapshot: (snapshot: GameStateResponse) => void) {
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
      onSnapshot(JSON.parse(data) as GameStateResponse)
    } catch {
      // Ignore malformed SSE payloads and keep the stream alive.
    }
  }

  return remainder
}
