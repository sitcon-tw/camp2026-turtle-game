export const TEAM_TOKEN_KEY = "turtle-team-token"

export function getTeamToken() {
  return window.localStorage.getItem(TEAM_TOKEN_KEY)
}

export function setTeamToken(token: string) {
  window.localStorage.setItem(TEAM_TOKEN_KEY, token)
}

export function clearTeamToken() {
  window.localStorage.removeItem(TEAM_TOKEN_KEY)
}
