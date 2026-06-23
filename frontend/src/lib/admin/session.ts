const TOKEN_KEY = "turtle-admin-token"

export function getAdminToken() {
  return window.localStorage.getItem(TOKEN_KEY)
}

export function setAdminToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token)
}

export function clearAdminToken() {
  window.localStorage.removeItem(TOKEN_KEY)
}
