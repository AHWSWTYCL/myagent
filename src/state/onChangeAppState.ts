import type { AgentMode, AppState } from './appState.js'

type AppStateChange = {
  newState: AppState
  oldState: AppState
}

type ModeChangeHandler = (mode: AgentMode) => void

let modeChangeHandler: ModeChangeHandler | undefined

export function setModeChangeHandler(handler: ModeChangeHandler | undefined): void {
  modeChangeHandler = handler
}

export function onChangeAppState({ newState, oldState }: AppStateChange): void {
  if (newState.mode !== oldState.mode) {
    modeChangeHandler?.(newState.mode)
  }
}
