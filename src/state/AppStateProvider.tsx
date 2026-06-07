import React, { useContext, useState, useSyncExternalStore } from 'react'
import { appStateStore, getDefaultAppState, type AppState, type AppStateStore } from './appState.js'
import { createStore } from './store.js'

const AppStoreContext = React.createContext<AppStateStore | null>(null)
const HasAppStateContext = React.createContext(false)

interface Props {
  children?: React.ReactNode
  store?: AppStateStore
  initialState?: AppState
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void
}

export function AppStateProvider({ children, store: providedStore, initialState, onChangeAppState }: Props): React.ReactNode {
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error('AppStateProvider cannot be nested')
  }

  const [store] = useState(() => providedStore ?? createStore(initialState ?? getDefaultAppState(), onChangeAppState))

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}

function useAppStore(): AppStateStore {
  const store = useContext(AppStoreContext)
  if (!store) {
    throw new ReferenceError('useAppState/useSetAppState cannot be called outside AppStateProvider')
  }
  return store
}

export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  const getSnapshot = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function useSetAppState(): AppStateStore['setState'] {
  return useAppStore().setState
}

export function useAppStateStore(): AppStateStore {
  return useAppStore()
}

export { appStateStore }
