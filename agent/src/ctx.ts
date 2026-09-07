import type { Config } from '@dogegg/bridge'
import type { StateMachine } from './turn'
import type { ContextAssembler } from './context'
import type { PermissionManager } from './permission'
import type { BusyGate } from './shared'

// Agent 运行期可变状态的唯一持有者——无方法的普通对象（所有权立法见 spec §4）。
//
// 约定：
// 1. 其余组件持 ctx 稳定引用、调用时读取——禁止把 ctx 的成员包成 accessor 回调外传；
// 2. config / permission / assembler 在配置编辑时由 Agent 整体替换；
// 3. machine 只被 fire（全项目唯一状态机），gate 只被 enter/leave/cancel；
// 4. 禁止往 ctx 增添派生业务方法——派生值（如连接参数）在命令时刻由门面解析成值传入。
export interface AgentContext {
  config: Config
  permission: PermissionManager
  assembler: ContextAssembler
  machine: StateMachine
  gate: BusyGate
}
