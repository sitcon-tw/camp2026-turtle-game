export const TEAM_TOKEN_KEY = "turtle-team-token"
const TEAM_DEVICE_ID_KEY = "turtle-team-device-id"

export function getTeamToken() {
  return window.localStorage.getItem(TEAM_TOKEN_KEY)
}

export function setTeamToken(token: string) {
  window.localStorage.setItem(TEAM_TOKEN_KEY, token)
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
