import React, { useContext, useState, useRef, useCallback, useSyncExternalStore } from 'react'
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
  // selector 通常是内联箭头函数，用 ref 捕获最新版本
  // getSnapshot 的引用必须稳定，否则 useSyncExternalStore 的 tearing check
  // 可能触发额外的同步重渲染，形成无限循环
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const getSnapshot = useCallback(
    () => selectorRef.current(store.getState()),
    [store],  // store 来自 useState，整个生命周期稳定
  )
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function useSetAppState(): AppStateStore['setState'] {
  return useAppStore().setState
}

export function useAppStateStore(): AppStateStore {
  return useAppStore()
}

export { appStateStore }
