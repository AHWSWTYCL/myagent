import { describe, it, expect } from 'vitest'
import { extractAtToken, applyFileCompletion } from '../tui/fileSuggestions.js'

describe('extractAtToken', () => {
  it('cursor right after @ (empty path)', () => {
    expect(extractAtToken('@', 1)).toEqual({
      tokenStart: 0, tokenEnd: 1, pathPrefix: '',
    })
  })

  it('cursor inside path after @', () => {
    expect(extractAtToken('@src/t', 6)).toEqual({
      tokenStart: 0, tokenEnd: 6, pathPrefix: 'src/t',
    })
  })

  it('@ in middle of text', () => {
    expect(extractAtToken('hello @src/t world', 12)).toEqual({
      tokenStart: 6, tokenEnd: 12, pathPrefix: 'src/t',
    })
  })

  it('no @', () => {
    expect(extractAtToken('hello world', 5)).toBeNull()
  })

  it('@teammate with cursor inside token', () => {
    // cursor at pos 8, still inside @teammate
    expect(extractAtToken('@teammate hello', 8)).toEqual({
      tokenStart: 0, tokenEnd: 9, pathPrefix: 'teammate',
    })
  })

  it('@teammate with cursor on space after token', () => {
    // cursor at pos 9 on the space → still finds the @token (boundary case)
    expect(extractAtToken('@teammate hello', 9)).toEqual({
      tokenStart: 0, tokenEnd: 9, pathPrefix: 'teammate',
    })
  })

  it('multiple @ signs, cursor on second', () => {
    expect(extractAtToken('@foo @bar', 8)).toEqual({
      tokenStart: 5, tokenEnd: 9, pathPrefix: 'bar',
    })
  })

  it('cursor past @token into next word', () => {
    // cursor at pos 7 (on 'h' of 'hello'), past @file → returns null
    expect(extractAtToken('@file hello', 7)).toBeNull()
  })
})

describe('applyFileCompletion', () => {
  it('replace @token with completed path', () => {
    const result = applyFileCompletion('hello @src/t world', 6, 12, '@src/tui')
    expect(result).toBe('hello @src/tui world')
  })

  it('replace at start of input', () => {
    const result = applyFileCompletion('@src/t', 0, 6, '@src/tui/App.tsx')
    expect(result).toBe('@src/tui/App.tsx')
  })

  it('append trailing content', () => {
    const result = applyFileCompletion('check @sr more', 6, 9, '@src/tui/App.tsx')
    expect(result).toBe('check @src/tui/App.tsx more')
  })
})
