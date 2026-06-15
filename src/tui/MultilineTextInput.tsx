import React, { useState, useEffect } from 'react'
import { Text, useInput } from 'ink'
import chalk from 'chalk'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  placeholder?: string
  focus?: boolean
  showCursor?: boolean
  mask?: string
}

export function MultilineTextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
  showCursor = true,
  mask,
}: Props) {
  const [state, setState] = useState({
    cursorOffset: value.length,
    cursorWidth: 0,
  })
  const { cursorOffset, cursorWidth } = state

  useEffect(() => {
    setState(previousState => {
      if (!focus || !showCursor) {
        return previousState
      }
      if (previousState.cursorOffset > value.length - 1) {
        return {
          cursorOffset: value.length,
          cursorWidth: 0,
        }
      }
      return previousState
    })
  }, [value, focus, showCursor])

  const cursorActualWidth = cursorWidth
  const displayValue = mask ? mask.repeat(value.length) : value
  let renderedValue = displayValue
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined

  // Fake cursor using inverse text, same approach as ink-text-input
  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ')

    renderedValue = displayValue.length > 0 ? '' : chalk.inverse(' ')
    let i = 0
    for (const char of displayValue) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char
      i++
    }
    if (displayValue.length > 0 && cursorOffset === displayValue.length) {
      renderedValue += chalk.inverse(' ')
    }
  }

  useInput((input, key) => {
    if (!focus) return

    // Pass through keys that parent handlers need
    if (
      key.upArrow ||
      key.downArrow ||
      (key.ctrl && input === 'c') ||
      key.tab ||
      (key.shift && key.tab)
    ) {
      return
    }

    // Ctrl+Enter / Alt+Enter / Shift+Enter / literal \n: insert newline at cursor position
    // (for terminals that do distinguish modified Enter)
    if ((key.return && (key.ctrl || key.meta || key.shift)) || input === '\n') {
      const nextValue =
        value.slice(0, cursorOffset) +
        '\n' +
        value.slice(cursorOffset)
      onChange(nextValue)
      setState(prev => ({
        cursorOffset: prev.cursorOffset + 1,
        cursorWidth: 0,
      }))
      return
    }

    // Enter: submit — unless value ends with '\', then insert newline instead.
    // Trailing backslash is the most portable multi-line mechanism (all terminals).
    if (key.return) {
      if (value.endsWith('\\')) {
        const nextValue = value.slice(0, -1) + '\n'
        onChange(nextValue)
        setState(prev => ({
          cursorOffset: nextValue.length,
          cursorWidth: 0,
        }))
        return
      }
      if (onSubmit) {
        onSubmit(value)
      }
      return
    }

    let nextCursorOffset = cursorOffset
    let nextValue = value
    let nextCursorWidth = 0

    if (key.leftArrow) {
      if (showCursor) {
        nextCursorOffset--
      }
    } else if (key.rightArrow) {
      if (showCursor) {
        nextCursorOffset++
      }
    } else if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        nextValue =
          value.slice(0, cursorOffset - 1) +
          value.slice(cursorOffset)
        nextCursorOffset--
      }
    } else {
      nextValue =
        value.slice(0, cursorOffset) +
        input +
        value.slice(cursorOffset)
      nextCursorOffset += input.length

      if (input.length > 1) {
        nextCursorWidth = input.length
      }
    }

    if (cursorOffset < 0) {
      nextCursorOffset = 0
    }

    if (cursorOffset > value.length) {
      nextCursorOffset = value.length
    }

    setState({
      cursorOffset: nextCursorOffset,
      cursorWidth: nextCursorWidth,
    })

    if (nextValue !== value) {
      onChange(nextValue)
    }
  }, { isActive: focus })

  return (
    <Text>
      {placeholder
        ? displayValue.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  )
}
