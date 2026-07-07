import type { UseQueryResult } from "@tanstack/react-query"
import { useOutletContext } from "react-router-dom"

import type { GameEventConnectionState } from "@/hooks/use-game-events"
import type { GameStateResponse } from "@/lib/game/types"

export type AdminRouteContext = {
  game: UseQueryResult<GameStateResponse, Error>
  connectionState: GameEventConnectionState
}

export function useAdminRouteContext() {
  return useOutletContext<AdminRouteContext>()
}
