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

  it("clears the matching station session id", () => {
    window.sessionStorage.setItem("turtle-team-station-session-id", "session-a")

    clearTeamStationSessionId("session-a")

    expect(window.sessionStorage.getItem("turtle-team-station-session-id")).toBeNull()
  })
})
