/**
 * Orca AttentionRuleConfigLoader —— Phase 3.B.rule-config
 *
 * 设计原则（用户决策）：
 * - 只支持 JSON（项目无 YAML 依赖；不新增依赖）
 * - 严格白名单：只解析 `enabled` 字段，其他字段直接报错（防 DSL 倾向）
 * - 不创建新 Rule——Rule 必须先由 TypeScript 代码 register
 * - 未知 ruleId 抛错（fail-fast；不静默错误）
 * - 不污染 defaultRegistry——Loader 接受 registry 参数
 *
 * 严格禁止：
 * - ❌ YAML parser（当前阶段不引入新依赖）
 * - ❌ DSL / 表达式 / JavaScript 注入
 * - ❌ LLM rule generation（Phase 5+）
 */

import type {
  AttentionRuleConfig,
  AttentionRuleConfigEntry,
  AttentionRuleConfigLoader,
  AttentionRuleRegistry,
} from '../types/attention.js'

/** 规则 entry 允许的字段白名单（防止 predicate DSL 倾向） */
const ALLOWED_ENTRY_KEYS = new Set(['enabled'])

/**
 * Parse JSON string → AttentionRuleConfig
 *
 * 严格校验（任一失败抛 Error）：
 * 1. JSON.parse 合法
 * 2. 顶层是 object（非 array / null）
 * 3. 顶层包含 `rules` 字段（object，非 array）
 * 4. 每个 ruleId 是非空字符串
 * 5. 每个 entry 是 object（非 array / null）
 * 6. 每个 entry 仅包含白名单字段（其他字段直接报错）
 * 7. enabled 字段是 boolean（缺省视为 true）
 *
 * 注意：parse 阶段**不检查 ruleId 是否在 registry 中注册**——那是 load 阶段的职责。
 */
function parseRuleConfig(jsonText: string): AttentionRuleConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`[rule-config] JSON parse error: ${detail}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[rule-config] 配置必须是 JSON object')
  }

  const obj = parsed as Record<string, unknown>
  const rulesField = obj.rules
  if (!rulesField || typeof rulesField !== 'object' || Array.isArray(rulesField)) {
    throw new Error('[rule-config] 配置必须包含 "rules" object 字段')
  }

  const rules: Record<string, AttentionRuleConfigEntry> = {}
  for (const [ruleId, entry] of Object.entries(rulesField as Record<string, unknown>)) {
    if (typeof ruleId !== 'string' || ruleId.length === 0) {
      throw new Error(`[rule-config] 规则 id 必须是非空字符串，收到: ${JSON.stringify(ruleId)}`)
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`[rule-config] 规则 '${ruleId}' 的 entry 必须是 object`)
    }
    const e = entry as Record<string, unknown>

    // 拒绝未知字段（防 DSL 倾向：写 `predicate: "..."` 直接报错）
    for (const key of Object.keys(e)) {
      if (!ALLOWED_ENTRY_KEYS.has(key)) {
        throw new Error(
          `[rule-config] 规则 '${ruleId}' 不支持的字段: '${key}'（只允许: ${[...ALLOWED_ENTRY_KEYS].join(', ')}）`,
        )
      }
    }

    // enabled：缺省 true；非 boolean → 报错
    const enabledRaw = e.enabled
    const enabled: boolean = enabledRaw === undefined ? true : enabledRaw as boolean
    if (typeof enabled !== 'boolean') {
      throw new Error(`[rule-config] 规则 '${ruleId}' 的 enabled 必须是 boolean（收到: ${typeof enabledRaw}）`)
    }

    rules[ruleId] = { enabled }
  }

  return { rules }
}

/**
 * 应用配置到 registry（仅设置 enabled 状态）
 *
 * 严格行为：
 * - 不创建新 Rule（必须已注册）
 * - 未知 ruleId → 抛错（fail-fast）
 * - 即便 disabled → 仍调用 setEnabled(false)（状态可重入）
 */
function applyRuleConfig(
  config: AttentionRuleConfig,
  registry: AttentionRuleRegistry,
): void {
  for (const [ruleId, entry] of Object.entries(config.rules)) {
    if (!registry.getAllRules().some((r) => r.id === ruleId)) {
      throw new Error(`[rule-config] 未知 ruleId: '${ruleId}'（registry 中未注册）`)
    }
    registry.setEnabled(ruleId, entry.enabled)
  }
}

/**
 * 工厂函数：返回 AttentionRuleConfigLoader 实例
 *
 * 使用方式：
 * ```ts
 * const loader = createRuleConfigLoader()
 * const cfg = loader.parse(jsonText)   // 纯函数，可独立测试
 * loader.load(cfg, myRegistry)         // 副作用；可作用于任意 registry
 * ```
 */
export function createRuleConfigLoader(): AttentionRuleConfigLoader {
  return {
    parse: parseRuleConfig,
    load: applyRuleConfig,
  }
}
