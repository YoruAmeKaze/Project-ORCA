/**
 * Orca RuntimeAdapter —— 统一生命周期接口（Phase 7.1A）
 *
 * 职责：
 * - 所有外部数据源 Adapter（Scheduler / Calendar / PC / Weather / Phone）必须实现此接口
 * - start()：Adapter 启动，开始向 EventBus 发射事件
 * - stop()：Adapter 停止，清理所有资源（timer、连接等）
 *
 * 设计原则（GPT Review Phase 7.0）：
 * - RuntimeAdapter 负责监听或轮询自己的数据源，并 emit Event
 * - **不直接修改 WorldState**
 * - 所有状态变更必须经过 EventBus → WorldStateUpdater（Reducer）路径
 *
 * 事件流向：
 *   RuntimeAdapter.start() → EventBus.publish(event) → WorldStateUpdater（Reducer）→ WorldState
 *
 * 不做（Phase 7.1A 范围外）：
 * - 不实现真实 Weather Adapter（Phase 7.x）
 * - 不实现外部 API 轮询
 * - 不实现重试/backoff 逻辑
 */

/**
 * 统一 RuntimeAdapter 接口。
 *
 * 所有输入 Adapter 必须：
 * - start()：启动数据源监听/轮询，向 EventBus 发射事件
 * - stop()：清理所有资源（timer、连接、订阅等）
 *
 * start() 和 stop() 可以是同步或异步。
 * Cordis plugin 机制会在 dispose 时调用 stop()（如果返回的是 dispose 函数）。
 */
export interface RuntimeAdapter {
  /**
   * 启动 Adapter。
   * @returns void 或 Promise（异步启动时）
   */
  start(): void | Promise<void>

  /**
   * 停止 Adapter 并清理资源。
   * @returns void 或 Promise（异步清理时）
   */
  stop(): void | Promise<void>
}

/**
 * RuntimeAdapter 配置基础接口。
 * 具体 Adapter 可以扩展此接口添加自己的配置项。
 */
export interface RuntimeAdapterConfig {
  /** 是否启用（默认 false） */
  enabled: boolean
  /** 轮询间隔（毫秒） */
  refreshMs?: number
}
