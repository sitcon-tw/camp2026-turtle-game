import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent } from "react"
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToWindowEdges } from "@dnd-kit/modifiers"
import { ClockIcon, GripVerticalIcon, RotateCcwIcon, WifiIcon, WifiOffIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { GameEventConnectionState } from "@/hooks/use-game-events"
import type { GamePhase, GameStateResponse } from "@/lib/game/types"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "turtle-admin-floating-timer-position:v1"
const TIMER_ID = "admin-floating-timer"
const DEFAULT_MARGIN = 20
const DEFAULT_TIMER_SIZE: TimerSize = { width: 260, height: 112 }
const MOBILE_QUERY = "(max-width: 639px)"
const KEYBOARD_STEP = 16
const KEYBOARD_STEP_LARGE = 48

type Position = {
  x: number
  y: number
}

type TimerSize = {
  width: number
  height: number
}

type AdminFloatingTimerProps = {
  snapshot: GameStateResponse | null | undefined
  connectionState: GameEventConnectionState
  loading?: boolean
}

export function AdminFloatingTimer({ snapshot, connectionState, loading = false }: AdminFloatingTimerProps) {
  const timerRef = useRef<HTMLDivElement | null>(null)
  const [timerSize, setTimerSize] = useState<TimerSize>(DEFAULT_TIMER_SIZE)
  const [position, setPosition] = useState<Position | null>(null)
  const [mounted, setMounted] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  )

  const setClampedPosition = useCallback((next: Position, persist = true) => {
    setPosition(() => {
      const clamped = clampPosition(next, measureViewport(), measureTimer(timerRef.current, timerSize))
      if (persist) persistPosition(clamped)
      return clamped
    })
  }, [timerSize])

  useLayoutEffect(() => {
    const size = measureTimer(timerRef.current, DEFAULT_TIMER_SIZE)
    setTimerSize(size)
    setPosition(clampPosition(loadPosition() ?? defaultPosition(size), measureViewport(), size))
    setMounted(true)
  }, [])

  useEffect(() => {
    const element = timerRef.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const nextSize = {
        width: entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width,
        height: entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height,
      }
      setTimerSize(nextSize)
      setPosition((current) => {
        const next = clampPosition(current ?? defaultPosition(nextSize), measureViewport(), nextSize)
        persistPosition(next)
        return next
      })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    function handleResize() {
      setPosition((current) => {
        const next = clampPosition(current ?? defaultPosition(timerSize), measureViewport(), timerSize)
        persistPosition(next)
        return next
      })
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [timerSize])

  function handleDragEnd(event: DragEndEvent) {
    if (!position) return
    setClampedPosition({
      x: position.x + event.delta.x,
      y: position.y + event.delta.y,
    })
  }

  function handleReset() {
    setClampedPosition(defaultPosition(timerSize))
  }

  function handleKeyboardMove(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP
    const deltaByKey: Partial<Record<string, Position>> = {
      ArrowDown: { x: 0, y: step },
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
    }
    const delta = deltaByKey[event.key]
    if (!delta || !position) return

    event.preventDefault()
    setClampedPosition({ x: position.x + delta.x, y: position.y + delta.y })
  }

  const currentPosition = position ?? defaultPosition(timerSize)

  return (
    <DndContext sensors={sensors} modifiers={[restrictToWindowEdges]} onDragEnd={handleDragEnd}>
      <FloatingTimerCard
        ref={timerRef}
        position={currentPosition}
        snapshot={snapshot}
        connectionState={connectionState}
        loading={loading}
        mounted={mounted}
        onKeyboardMove={handleKeyboardMove}
        onReset={handleReset}
      />
    </DndContext>
  )
}

type FloatingTimerCardProps = {
  position: Position
  snapshot: GameStateResponse | null | undefined
  connectionState: GameEventConnectionState
  loading: boolean
  mounted: boolean
  onKeyboardMove: (event: KeyboardEvent<HTMLButtonElement>) => void
  onReset: () => void
}

const FloatingTimerCard = forwardRef<HTMLDivElement, FloatingTimerCardProps>(function FloatingTimerCard({
  position,
  snapshot,
  connectionState,
  loading,
  mounted,
  onKeyboardMove,
  onReset,
}, ref) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: TIMER_ID })
  const seconds = useRemainingSeconds(snapshot)
  const phase = snapshot?.state.phase ?? "idle"
  const title = loading
    ? "同步遊戲狀態"
    : snapshot?.challenge?.title ?? (phase === "idle" ? "目前沒有進行中的回合" : "目前階段")
  const connectionOpen = connectionState === "open"
  const style = useMemo<CSSProperties>(() => ({
    left: position.x,
    top: position.y,
    opacity: mounted ? 1 : 0,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
  }), [mounted, position.x, position.y, transform])

  function assignNode(node: HTMLDivElement | null) {
    setNodeRef(node)
    if (typeof ref === "function") {
      ref(node)
    } else if (ref) {
      ref.current = node
    }
  }

  return (
    <aside
      ref={assignNode}
      className={cn(
        "fixed z-30 w-[min(calc(100vw-2rem),17rem)] rounded-[1rem] border-2 border-ink bg-card/95 text-ink shadow-[4px_4px_0_rgba(23,35,58,0.18)] backdrop-blur transition-opacity",
        isDragging ? "cursor-grabbing shadow-[6px_6px_0_rgba(23,35,58,0.22)]" : "cursor-default",
      )}
      style={style}
      aria-label="管理員浮動計時器"
      data-admin-floating-timer
    >
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          className="mt-0.5 flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md border-2 border-ink bg-surface-raised text-muted-foreground shadow-[2px_2px_0_rgba(23,35,58,0.12)] outline-none transition hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
          aria-label="拖曳浮動計時器。可用方向鍵移動。"
          onKeyDown={onKeyboardMove}
          {...listeners}
          {...attributes}
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-black text-muted-foreground">
              <ClockIcon className="size-4 shrink-0" />
              <span className="truncate">計時器</span>
            </div>
            <Badge variant={connectionOpen ? "secondary" : "outline"} className="shrink-0 gap-1 font-black">
              {connectionOpen ? <WifiIcon className="size-3" /> : <WifiOffIcon className="size-3" />}
              {connectionOpen ? "即時" : "同步"}
            </Badge>
          </div>
          <div className="mt-1 truncate text-sm font-black">{phaseLabel(phase)}</div>
          <div className="truncate text-xs font-bold text-muted-foreground">{title}</div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <div className="font-mono text-3xl font-black leading-none tabular-nums">{formatTimer(seconds)}</div>
            <Button variant="ghost" size="icon-xs" onClick={onReset} aria-label="重設浮動計時器位置">
              <RotateCcwIcon />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  )
})

function useRemainingSeconds(snapshot: GameStateResponse | null | undefined) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!snapshot?.state.phase_ends_at) return null
  return Math.max(0, Math.ceil((Date.parse(snapshot.state.phase_ends_at) - now) / 1_000))
}

function defaultPosition(size: TimerSize): Position {
  const viewport = measureViewport()
  const mobile = window.matchMedia(MOBILE_QUERY).matches
  return clampPosition(
    {
      x: mobile ? (viewport.width - size.width) / 2 : viewport.width - size.width - DEFAULT_MARGIN,
      y: viewport.height - size.height - DEFAULT_MARGIN,
    },
    viewport,
    size,
  )
}

function clampPosition(position: Position, viewport: TimerSize, size: TimerSize): Position {
  return {
    x: clamp(position.x, DEFAULT_MARGIN, Math.max(DEFAULT_MARGIN, viewport.width - size.width - DEFAULT_MARGIN)),
    y: clamp(position.y, DEFAULT_MARGIN, Math.max(DEFAULT_MARGIN, viewport.height - size.height - DEFAULT_MARGIN)),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function measureViewport(): TimerSize {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

function measureTimer(element: HTMLDivElement | null, fallback: TimerSize): TimerSize {
  if (!element) return fallback
  const rect = element.getBoundingClientRect()
  return {
    width: rect.width || fallback.width,
    height: rect.height || fallback.height,
  }
}

function loadPosition(): Position | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Position>
    return typeof parsed.x === "number" && typeof parsed.y === "number" ? { x: parsed.x, y: parsed.y } : null
  } catch {
    return null
  }
}

function persistPosition(position: Position) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position))
  } catch {
    // Position persistence is best-effort only.
  }
}

function phaseLabel(phase: GamePhase) {
  const labels: Record<GamePhase, string> = {
    idle: "閒置",
    submission_open: "開放提交",
    team_selection: "隊內選拔",
    public_voting: "公開投票",
    scoring: "計分中",
    round_complete: "回合完成",
  }
  return labels[phase]
}

function formatTimer(seconds: number | null) {
  if (seconds === null) return "--:--"
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}
