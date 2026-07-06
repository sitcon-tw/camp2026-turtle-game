import { useEffect, useRef, useState } from "react"

export type BlackboardStreamViewerStatus = "idle" | "connecting" | "live" | "error" | "unsupported"

type UseBlackboardStreamViewerOptions = {
  sessionId: string | null
  enabled?: boolean
  url: string | null
  hello?: Record<string, unknown> | null
}

type ViewerSignalPayload = {
  type?: string
  sdp?: string
  candidate?: RTCIceCandidateInit
  target_fps?: number
}

export function useBlackboardStreamViewer({
  sessionId,
  enabled = true,
  url,
  hello = null,
}: UseBlackboardStreamViewerOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<BlackboardStreamViewerStatus>("idle")
  const [fps, setFps] = useState(0)
  const [targetFps, setTargetFps] = useState<number | null>(null)

  useEffect(() => {
    if (!sessionId || !enabled || !url) {
      const resetTimer = window.setTimeout(() => {
        setStatus("idle")
        setFps(0)
        setTargetFps(null)
      }, 0)
      return () => window.clearTimeout(resetTimer)
    }
    if (typeof WebSocket === "undefined" || typeof RTCPeerConnection === "undefined") {
      const resetTimer = window.setTimeout(() => {
        setStatus("unsupported")
        setFps(0)
        setTargetFps(null)
      }, 0)
      return () => window.clearTimeout(resetTimer)
    }

    let cancelled = false
    let peerConnection: RTCPeerConnection | null = null
    let socket: WebSocket | null = null
    let frameCallbackId = 0
    const resetTimer = window.setTimeout(() => {
      if (cancelled) return
      setStatus("connecting")
      setFps(0)
      setTargetFps(null)
    }, 0)

    function ensurePeerConnection() {
      if (peerConnection) return peerConnection
      const nextPeerConnection = new RTCPeerConnection({ iceServers: rtcIceServers() })
      peerConnection = nextPeerConnection
      nextPeerConnection.addEventListener("icecandidate", (event) => {
        if (!event.candidate || socket?.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({
          type: "webrtc_ice_candidate",
          candidate: event.candidate.toJSON(),
        }))
      })
      nextPeerConnection.addEventListener("connectionstatechange", () => {
        if (!peerConnection) return
        if (peerConnection.connectionState === "connected") setStatus("live")
        if (peerConnection.connectionState === "failed") setStatus("error")
      })
      nextPeerConnection.addEventListener("track", (event) => {
        const [stream] = event.streams
        const video = videoRef.current
        if (!video || !stream) return
        video.srcObject = stream
        void video.play().catch(() => undefined)
        setStatus("live")
        startFpsMonitor(video)
      })
      return nextPeerConnection
    }

    function startFpsMonitor(video: HTMLVideoElement) {
      if (!("requestVideoFrameCallback" in video)) return
      let frames = 0
      let lastSampleAt = performance.now()
      const onFrame: VideoFrameRequestCallback = (now) => {
        if (cancelled) return
        frames += 1
        if (now - lastSampleAt >= 1_000) {
          setFps((frames * 1_000) / (now - lastSampleAt))
          frames = 0
          lastSampleAt = now
        }
        frameCallbackId = video.requestVideoFrameCallback(onFrame)
      }
      frameCallbackId = video.requestVideoFrameCallback(onFrame)
    }

    async function handleMessage(event: MessageEvent) {
      try {
        const payload = JSON.parse(String(event.data)) as ViewerSignalPayload
        if (payload.type === "stream_error" || payload.type === "webrtc_stream_closed") {
          setStatus("error")
          closePeerConnection()
          return
        }
        if (payload.type === "webrtc_viewer_ready" && typeof payload.target_fps === "number") {
          setTargetFps(payload.target_fps)
        }
        if (payload.type === "webrtc_offer" && payload.sdp) {
          const connection = ensurePeerConnection()
          await connection.setRemoteDescription({ type: "offer", sdp: payload.sdp })
          const answer = await connection.createAnswer()
          await connection.setLocalDescription(answer)
          if (socket?.readyState === WebSocket.OPEN && connection.localDescription) {
            socket.send(JSON.stringify({
              type: "webrtc_answer",
              sdp: connection.localDescription.sdp,
            }))
          }
        }
        if (payload.type === "webrtc_ice_candidate" && payload.candidate) {
          await ensurePeerConnection().addIceCandidate(payload.candidate)
        }
      } catch {
        setStatus("error")
      }
    }

    function closePeerConnection() {
      if (frameCallbackId && videoRef.current && "cancelVideoFrameCallback" in videoRef.current) {
        videoRef.current.cancelVideoFrameCallback(frameCallbackId)
      }
      if (videoRef.current) videoRef.current.srcObject = null
      peerConnection?.close()
      peerConnection = null
      setFps(0)
    }

    socket = new WebSocket(url)
    socket.addEventListener("open", () => {
      if (hello && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(hello))
      }
    })
    socket.addEventListener("message", (event) => {
      void handleMessage(event)
    })
    socket.addEventListener("close", () => {
      if (!cancelled) setStatus("error")
      closePeerConnection()
    })
    socket.addEventListener("error", () => {
      setStatus("error")
    })

    return () => {
      cancelled = true
      window.clearTimeout(resetTimer)
      socket?.close()
      closePeerConnection()
    }
  }, [enabled, hello, sessionId, url])

  return { videoRef, status, fps, targetFps }
}

export function publicStreamViewerSocketUrl(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  const params = new URLSearchParams({ session_id: sessionId })
  return `${protocol}//${window.location.host}/api/v1/blackboard/stream/viewer?${params}`
}

export function adminPreviewViewerSocketUrl(sessionId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/api/v1/admin/blackboard/stream-sessions/${sessionId}/viewer`
}

function rtcIceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_WEBRTC_ICE_SERVERS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return raw
      .split(",")
      .map((candidate: string) => candidate.trim())
      .filter(Boolean)
      .map((urls: string) => ({ urls }))
  }
}
