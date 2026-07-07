import { beforeEach, describe, expect, it } from "vitest"

import { clearTeamStationSessionId, getTeamStationSessionId } from "./session"

describe("student station session", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it("keeps a stable station session id within the browser tab", () => {
    const first = getTeamStationSessionId()
    const second = getTeamStationSessionId()

    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it("migrates the legacy stream session id", () => {
    window.sessionStorage.setItem("turtle-stream-session-id", "stream-session-a")

    expect(getTeamStationSessionId()).toBe("stream-session-a")
  })

  it("clears the matching station and legacy session ids", () => {
    window.sessionStorage.setItem("turtle-team-station-session-id", "session-a")
    window.sessionStorage.setItem("turtle-stream-session-id", "session-a")

    clearTeamStationSessionId("session-a")

    expect(window.sessionStorage.getItem("turtle-team-station-session-id")).toBeNull()
    expect(window.sessionStorage.getItem("turtle-stream-session-id")).toBeNull()
  })
})
