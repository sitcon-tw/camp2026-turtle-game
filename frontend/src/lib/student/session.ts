export const TEAM_TOKEN_KEY = "turtle-team-token"
const TEAM_DEVICE_ID_KEY = "turtle-team-device-id"
const TEAM_STATION_SESSION_ID_KEY = "turtle-team-station-session-id"

export function getTeamToken() {
  return window.localStorage.getItem(TEAM_TOKEN_KEY)
}

export function setTeamToken(token: string) {
  window.localStorage.setItem(TEAM_TOKEN_KEY, token)
  getTeamStationSessionId()
}

export function clearTeamToken() {
  window.localStorage.removeItem(TEAM_TOKEN_KEY)
}

export function getTeamDeviceId() {
  const existing = window.localStorage.getItem(TEAM_DEVICE_ID_KEY)
  if (existing) return existing

  const deviceId = crypto.randomUUID()
  window.localStorage.setItem(TEAM_DEVICE_ID_KEY, deviceId)
  return deviceId
}

export function getTeamStationSessionId() {
  const existing = window.sessionStorage.getItem(TEAM_STATION_SESSION_ID_KEY)
  if (existing) return existing

  const sessionId = crypto.randomUUID()
  window.sessionStorage.setItem(TEAM_STATION_SESSION_ID_KEY, sessionId)
  return sessionId
}

export function clearTeamStationSessionId(sessionId: string) {
  if (window.sessionStorage.getItem(TEAM_STATION_SESSION_ID_KEY) === sessionId) {
    window.sessionStorage.removeItem(TEAM_STATION_SESSION_ID_KEY)
  }
}
