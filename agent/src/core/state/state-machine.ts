import type { State } from '@dogegg/bridge'
import { transition } from './transition'
import type { TransitionInput } from './events'

// 10 态状态机：封装当前态 + 迁移行为。迁移表本体（transition 纯函数）在同目录 transition.ts，有独立测试。
export class StateMachine {
  constructor(private current: State = 'idle') {}

  get state(): State {
    return this.current
  }

  // 计算并进入下一态，返回下一态——(input, 当前态) 非法组合时原地不动（迁移表的防护语义）。
  fire(input: TransitionInput): State {
    this.current = transition(this.current, input)
    return this.current
  }
}
