import { useCallback, useEffect, useRef, useState } from "react"

import { getTeamDeviceId } from "@/lib/student/session"

const STREAM_SESSION_ID_KEY = "turtle-stream-session-id"
const MAX_STREAM_WIDTH = 1280
const JPEG_QUALITY = 0.62
const REQUIRED_DISPLAY_SURFACE = "monitor"
const SNAPSHOT_FPS_FALLBACK = 1
const MEDIA_TARGET_FPS_FALLBACK = 30

type DisplaySurface = "application" | "browser" | "monitor" | "window"

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
  const snapshotFpsRef = useRef(SNAPSHOT_FPS_FALLBACK)
  const mediaTargetFpsRef = useRef(MEDIA_TARGET_FPS_FALLBACK)
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>())

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
      if (streamRef.current) stopMediaStream(streamRef.current)

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: REQUIRED_DISPLAY_SURFACE,
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      })
      const videoTrack = stream.getVideoTracks()[0]
      if (!videoTrack) {
        stopMediaStream(stream)
        setStatus("permission_required")
        setError("沒有取得可直播的螢幕畫面，請重新選擇「整個螢幕」。")
        return
      }

      const displaySurface = getDisplaySurface(videoTrack)
      if (displaySurface !== REQUIRED_DISPLAY_SURFACE) {
        stopMediaStream(stream)
        setStatus("permission_required")
        setError(displaySurface
          ? "請選擇分享「整個螢幕」，不要選擇 Chrome 分頁或應用程式視窗。"
          : "此瀏覽器無法確認你是否分享整個螢幕，請改用支援的 Chrome 或 Edge 後再開始。")
        return
      }

      streamRef.current = stream
      setCaptureVersion((version) => version + 1)
      setError(null)
      setStatus(token ? "connecting" : "permission_required")
      videoTrack.addEventListener("ended", () => {
        streamRef.current = null
        setDesiredFps(1)
        setStatus("permission_required")
        setError("直播分享已停止，請重新允許畫面直播。")
      })
    } catch (captureError) {
      streamRef.current = null
      setStatus("permission_required")
      setError(screenCaptureErrorMessage(captureError))
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
    const peerConnections = peerConnectionsRef.current
    const video = document.createElement("video")
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")

    function connect() {
      if (cancelled) return
      const sessionId = getStreamSessionId()
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
          const payload = JSON.parse(String(event.data)) as StreamSocketPayload
          if (payload.type === "stream_control" && typeof payload.desired_fps === "number") {
            setDesiredFps(Math.max(1, Math.min(12, Math.floor(payload.desired_fps))))
            if (typeof payload.snapshot_fps === "number") {
              snapshotFpsRef.current = Math.max(1, Math.min(12, Math.floor(payload.snapshot_fps)))
            }
            if (typeof payload.media_target_fps === "number") {
              mediaTargetFpsRef.current = Math.max(1, Math.min(60, Math.floor(payload.media_target_fps)))
            }
          }
          if (payload.type === "webrtc_viewer_joined" && payload.viewer_id) {
            void connectViewer(socket, payload.viewer_id)
          }
          if (payload.type === "webrtc_viewer_left" && payload.viewer_id) {
            closePeerConnection(payload.viewer_id)
          }
          if (payload.type === "webrtc_answer" && payload.viewer_id && payload.sdp) {
            void applyViewerAnswer(payload.viewer_id, payload.sdp)
          }
          if (payload.type === "webrtc_ice_candidate" && payload.viewer_id && payload.candidate) {
            void addViewerIceCandidate(payload.viewer_id, payload.candidate)
          }
          if (payload.type === "stream_error") {
            setError(payload.message ?? "直播連線失敗。")
            if (payload.code === "stream_session_invalid") {
              clearStreamSessionId(sessionId)
              socket.close()
            }
          }
        } catch {
          // Ignore malformed control messages.
        }
      })

      socket.addEventListener("close", () => {
        window.clearTimeout(frameTimer)
        closeAllPeerConnections()
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
      const snapshotFps = snapshotFpsRef.current || fps
      frameTimer = window.setTimeout(() => {
        void sendFrame(socket).finally(() => scheduleNextFrame(socket))
      }, Math.max(83, Math.floor(1_000 / snapshotFps)))
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

    async function connectViewer(socket: WebSocket, viewerId: string) {
      closePeerConnection(viewerId)
      if (socket.readyState !== WebSocket.OPEN || !streamRef.current) return

      const peerConnection = new RTCPeerConnection({ iceServers: rtcIceServers() })
      peerConnections.set(viewerId, peerConnection)
      for (const track of streamRef.current.getVideoTracks()) {
        applyMediaTargetFps(track, mediaTargetFpsRef.current)
        peerConnection.addTrack(track, streamRef.current)
      }
      peerConnection.addEventListener("icecandidate", (event) => {
        if (!event.candidate || socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({
          type: "webrtc_ice_candidate",
          viewer_id: viewerId,
          candidate: event.candidate.toJSON(),
        }))
      })
      peerConnection.addEventListener("connectionstatechange", () => {
        if (
          peerConnection.connectionState === "failed" ||
          peerConnection.connectionState === "closed" ||
          peerConnection.connectionState === "disconnected"
        ) {
          closePeerConnection(viewerId)
        }
      })

      try {
        const offer = await peerConnection.createOffer()
        await peerConnection.setLocalDescription(offer)
        if (socket.readyState === WebSocket.OPEN && peerConnection.localDescription) {
          socket.send(JSON.stringify({
            type: "webrtc_offer",
            viewer_id: viewerId,
            sdp: peerConnection.localDescription.sdp,
          }))
        }
      } catch {
        closePeerConnection(viewerId)
      }
    }

    async function applyViewerAnswer(viewerId: string, sdp: string) {
      const peerConnection = peerConnections.get(viewerId)
      if (!peerConnection || peerConnection.signalingState === "closed") return
      try {
        await peerConnection.setRemoteDescription({ type: "answer", sdp })
      } catch {
        closePeerConnection(viewerId)
      }
    }

    async function addViewerIceCandidate(viewerId: string, candidate: RTCIceCandidateInit) {
      const peerConnection = peerConnections.get(viewerId)
      if (!peerConnection || peerConnection.signalingState === "closed") return
      try {
        await peerConnection.addIceCandidate(candidate)
      } catch {
        // Ignore candidates that arrive after a peer has closed or restarted.
      }
    }

    function closePeerConnection(viewerId: string) {
      const peerConnection = peerConnections.get(viewerId)
      if (!peerConnection) return
      peerConnection.close()
      peerConnections.delete(viewerId)
    }

    function closeAllPeerConnections() {
      for (const peerConnection of peerConnections.values()) {
        peerConnection.close()
      }
      peerConnections.clear()
    }

    connect()

    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(frameTimer)
      closeAllPeerConnections()
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

type StreamSocketPayload = {
  type?: string
  code?: string
  desired_fps?: number
  snapshot_fps?: number
  media_active?: boolean
  media_target_fps?: number
  message?: string
  viewer_id?: string
  sdp?: string
  candidate?: RTCIceCandidateInit
}

function supportsDisplayCapture() {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia)
}

function getDisplaySurface(track: MediaStreamTrack): DisplaySurface | null {
  const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: DisplaySurface }
  return settings.displaySurface ?? null
}

function stopMediaStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

function screenCaptureErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "你取消或拒絕了畫面直播。請重新開始，並在分享視窗中選擇「整個螢幕」。"
  }
  return error instanceof Error ? error.message : "無法取得畫面直播權限。"
}

function getStreamSessionId() {
  const existing = window.sessionStorage.getItem(STREAM_SESSION_ID_KEY)
  if (existing) return existing
  const sessionId = crypto.randomUUID()
  window.sessionStorage.setItem(STREAM_SESSION_ID_KEY, sessionId)
  return sessionId
}

function clearStreamSessionId(sessionId: string) {
  if (window.sessionStorage.getItem(STREAM_SESSION_ID_KEY) === sessionId) {
    window.sessionStorage.removeItem(STREAM_SESSION_ID_KEY)
  }
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

function applyMediaTargetFps(track: MediaStreamTrack, targetFps: number) {
  const fps = mediaTargetFpsFromTrack(track, targetFps)
  if (!fps) return
  void track.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => undefined)
}

function mediaTargetFpsFromTrack(track: MediaStreamTrack, targetFps: number) {
  const capabilities = typeof track.getCapabilities === "function" ? track.getCapabilities() : null
  const maxFrameRate = capabilities?.frameRate?.max
  if (typeof maxFrameRate === "number") return Math.max(1, Math.min(targetFps, Math.floor(maxFrameRate)))
  return Math.max(1, targetFps)
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
      .map((url: string) => url.trim())
      .filter(Boolean)
      .map((urls: string) => ({ urls }))
  }
}
