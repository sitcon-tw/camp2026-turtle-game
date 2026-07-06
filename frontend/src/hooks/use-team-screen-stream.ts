import { useCallback, useEffect, useRef, useState } from "react"

import { getTeamDeviceId } from "@/lib/student/session"

const STREAM_SESSION_ID_KEY = "turtle-stream-session-id"
const MAX_STREAM_WIDTH = 1280
const JPEG_QUALITY = 0.62

export type TeamScreenStreamStatus =
  | "permission_required"
  | "connecting"
  | "live"
  | "error"
  | "unsupported"

export function useTeamScreenStream(token: string | null) {
  const [status, setStatus] = useState<TeamScreenStreamStatus>(() =>
    supportsDisplayCapture() ? "permission_required" : "unsupported",
  )
  const [error, setError] = useState<string | null>(null)
  const [desiredFps, setDesiredFps] = useState(1)
  const [captureVersion, setCaptureVersion] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const desiredFpsRef = useRef(1)

  useEffect(() => {
    desiredFpsRef.current = desiredFps
  }, [desiredFps])

  const requestCapture = useCallback(async () => {
    if (!supportsDisplayCapture()) {
      setStatus("unsupported")
      setError("此瀏覽器不支援畫面直播。")
      return
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 12, max: 12 },
        },
        audio: false,
      })
      streamRef.current = stream
      setCaptureVersion((version) => version + 1)
      setError(null)
      setStatus(token ? "connecting" : "permission_required")
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        streamRef.current = null
        setDesiredFps(1)
        setStatus("permission_required")
        setError("直播分享已停止，請重新允許畫面直播。")
      })
    } catch (captureError) {
      streamRef.current = null
      setStatus("permission_required")
      setError(captureError instanceof Error ? captureError.message : "無法取得畫面直播權限。")
    }
  }, [token])

  useEffect(() => {
    const stream = streamRef.current
    if (!token || !stream) return

    let cancelled = false
    let reconnectTimer = 0
    let frameTimer = 0
    let sendingFrame = false
    let activeSocket: WebSocket | null = null
    const video = document.createElement("video")
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    const sessionId = getStreamSessionId()

    function connect() {
      if (cancelled) return
      setStatus("connecting")
      const socket = new WebSocket(streamSocketUrl())
      activeSocket = socket
      socket.binaryType = "arraybuffer"

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "hello",
          token,
          session_id: sessionId,
          device_id: getTeamDeviceId(),
        }))
        setStatus("live")
        void video.play()
        scheduleNextFrame(socket)
      })

      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { type?: string; desired_fps?: number; message?: string }
          if (payload.type === "stream_control" && typeof payload.desired_fps === "number") {
            setDesiredFps(Math.max(1, Math.min(12, Math.floor(payload.desired_fps))))
          }
          if (payload.type === "stream_error") {
            setError(payload.message ?? "直播連線失敗。")
          }
        } catch {
          // Ignore malformed control messages.
        }
      })

      socket.addEventListener("close", () => {
        window.clearTimeout(frameTimer)
        if (!cancelled && streamRef.current) {
          setStatus("connecting")
          reconnectTimer = window.setTimeout(connect, 2_000)
        }
      })

      socket.addEventListener("error", () => {
        setError("直播連線中斷，正在重新連線。")
      })
    }

    function scheduleNextFrame(socket: WebSocket) {
      if (cancelled || socket.readyState !== WebSocket.OPEN) return
      const fps = desiredFpsRef.current
      frameTimer = window.setTimeout(() => {
        void sendFrame(socket).finally(() => scheduleNextFrame(socket))
      }, Math.max(83, Math.floor(1_000 / fps)))
    }

    async function sendFrame(socket: WebSocket) {
      if (!context || sendingFrame || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1_000_000) return
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return
      sendingFrame = true
      try {
        const scale = Math.min(1, MAX_STREAM_WIDTH / video.videoWidth)
        canvas.width = Math.max(1, Math.floor(video.videoWidth * scale))
        canvas.height = Math.max(1, Math.floor(video.videoHeight * scale))
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await canvasToBlob(canvas)
        if (blob && socket.readyState === WebSocket.OPEN) {
          socket.send(await blob.arrayBuffer())
        }
      } finally {
        sendingFrame = false
      }
    }

    connect()

    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(frameTimer)
      video.srcObject = null
      activeSocket?.close()
    }
  }, [captureVersion, token])

  return {
    status,
    error,
    desiredFps,
    requestCapture,
    isBlocking: status !== "live",
  }
}

function supportsDisplayCapture() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia)
}

function getStreamSessionId() {
  const existing = window.sessionStorage.getItem(STREAM_SESSION_ID_KEY)
  if (existing) return existing
  const sessionId = crypto.randomUUID()
  window.sessionStorage.setItem(STREAM_SESSION_ID_KEY, sessionId)
  return sessionId
}

function streamSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/api/v1/blackboard/stream/team`
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
  })
}
