import type { AppState } from './appState.js'

type AppStateChange = {
  newState: AppState
  oldState: AppState
}

type AutoModeHandler = (enabled: boolean) => void

let autoModeHandler: AutoModeHandler | undefined

export function setAutoModeChangeHandler(handler: AutoModeHandler | undefined): void {
  autoModeHandler = handler
}

export function onChangeAppState({ newState, oldState }: AppStateChange): void {
  if (newState.autoMode !== oldState.autoMode) {
    autoModeHandler?.(newState.autoMode)
  }
}
