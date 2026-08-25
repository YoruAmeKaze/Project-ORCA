/**
 * food-agent 真实视觉识别 CLI（L1 验证工具）。
 * 用法：node scripts/recognize-food.mjs <图片路径> [备注]
 * 流程：真实 Qwen 视觉识别 → 写 food-log 档案（data/records/food-agent.jsonl）→ 打印结果 + 档案回读校验。
 * 前置：.env 已配 QWEN_API_KEY（根 .env 或 app-cordis/.env）。
 */
import { getConfig, loadOrcaEnv } from '../dist/config.js'
import { VisionClient } from '../dist/services/vision.js'
import { JsonlInfoRecordStore } from '../dist/agents/store.js'
import { InfoExecutor } from '../dist/agents/executor.js'
import { foodLogAgent } from '../dist/agents/builtins/food-log.js'
import { existsSync } from 'node:fs'

loadOrcaEnv()
const config = getConfig()

const imagePath = process.argv[2]
const note = process.argv[3]
if (!imagePath) {
  console.error('用法: node scripts/recognize-food.mjs <图片路径> [备注]')
  process.exit(2)
}
if (!existsSync(imagePath)) {
  console.error(`图片不存在: ${imagePath}`)
  process.exit(2)
}
// 视觉后端：默认 dashscope（需 QWEN_API_KEY）；ORCA_VISION_BACKEND=ollama 走本地免 key。
// apiKey 校验交给 VisionClient（有 key 带头，无 key 不带头），这里只提示当前后端。
const backend = process.env.ORCA_VISION_BACKEND ?? 'dashscope'
console.log(`视觉后端: ${backend === 'ollama' ? `本地 Ollama (${config.qwen.model})` : `dashscope (${config.qwen.model})`}`)

const store = new JsonlInfoRecordStore(config.infoRecordsDir)
const executor = new InfoExecutor(console)
const result = await executor.execute(
  foodLogAgent,
  { agent: 'food-agent', input: { imagePath, note }, sessionId: 'cli' },
  { vision: new VisionClient(config.qwen), store, logger: console },
)

if (!result.ok) {
  console.error('识别失败:', JSON.stringify(result.error))
  process.exit(1)
}

console.log('\n==== 识别结果 ====')
console.log(JSON.stringify(result.data, null, 2))

// 档案回读校验（R0 复用前置条件）
const recent = await store.query({ namespaces: ['food-agent'], types: ['food-log'], limit: 5 })
console.log(`\n==== 档案回读（最近 ${recent.length} 条，data/records/food-agent.jsonl） ====`)
for (const r of recent) {
  const p = r.payload
  console.log(`- ${new Date(r.ts).toLocaleString('zh-CN', { hour12: false })} | ${p.food} ≈ ${p.kcal} kcal | confidence=${r.confidence} | source=${r.source} | photoRef=${p.photoRef}`)
}
console.log('\n下一步验证：起服务（ORCA_DRY_RUN=1）后问"吃了多少卡"，R0 应命中以上档案。')
