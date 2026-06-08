/**
 * GoalManager — 目标状态管理（单例模式）。
 *
 * 职责：
 *   1. 存储用户设定的 goal string
 *   2. 追踪迭代次数（防止无限循环）
 *   3. 不负责 spawn verifier（该逻辑在 GoalHook 中）
 */

const MAX_ITERATIONS = 3

export class GoalManager {
  private goal: string | null = null
  private active = false
  private iteration = 0

  /** 设置 goal 并激活 */
  setGoal(goal: string): void {
    this.goal = goal
    this.active = true
    this.iteration = 0
  }

  /** 清除 goal */
  clear(): void {
    this.goal = null
    this.active = false
    this.iteration = 0
  }

  /** 获取当前 goal 文本 */
  getGoal(): string | null {
    return this.goal
  }

  /** goal 是否处于激活状态 */
  isActive(): boolean {
    return this.active && this.goal !== null
  }

  /** 当前迭代次数 */
  getIteration(): number {
    return this.iteration
  }

  /** 迭代计数 +1 */
  incrementIteration(): void {
    this.iteration++
  }

  /** 是否达到最大迭代次数 */
  isMaxIterationsReached(): boolean {
    return this.iteration >= MAX_ITERATIONS
  }

  /** 获取最大迭代次数 */
  getMaxIterations(): number {
    return MAX_ITERATIONS
  }

  /** 停用 goal（迭代上限触发） */
  deactivate(): void {
    this.active = false
  }
}

/** 全局单例 */
export const goalManager = new GoalManager()
