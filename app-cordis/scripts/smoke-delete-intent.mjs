/**
 * Delete Intent 回归测试（v1.8.0 hotfix）。
 *
 * 目的：DELETE_INTENT_RE 在引入"不要"作为删除关键词时，误判"不要编""不要 emoji"
 *   "不要客气""具体一点详细一点，不要编"等普通否定表达为删除命令，
 *   导致 agent fast path 直接返回"没有可删的记录。"而不是走 LLM 主路径。
 *
 * 修复：DELETE_INTENT_RE 三条路径**都要求删除动词 +明确对象**同时出现，
 *   "不要"单独出现不再触发。
 *
 * 运行：npm run build && node scripts/smoke-delete-intent.mjs
 *
 * 覆盖：
 *   D1   "不要编"           → null（非删除）
 *   D2   "不要 emoji"        → null（非删除）
 *   D3   "不要客气"          → null（非删除）
 *   D4   "不要瞎说"          → null（非删除）
 *   D5   "具体一点详细一点，不要编，会就是会不会就是不会" → null（非删除）
 *   D6   "嗯"               → null（非删除）
 *   D7   "今天天气怎么样"     → null（非删除）
 *
 *   D8   "不要这条记录"      → string（删除）
 *   D9   "删掉测试记录"      → string（删除）
 *   D10  "删除这条记录"      → string（删除）
 *   D11  "清空饮食记录"      → string（删除）
 *   D12  "去掉刚才那条记录"   → string（删除）
 *   D13  "删掉火鸡面"        → string（删除，原 v1.6 兼容）
 *   D14  "清空记录"          → string（删除，原 v1.6 兼容）
 *   D15  "把测试记录删掉"     → string（删除，原 v1.6 兼容）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlInfoRecordStore } from '../dist/agents/store.js'
import { handleDeleteIntent } from '../dist/plugins/agent.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const tmpDir = mkdtempSync(join(tmpdir(), 'orca-delete-intent-'))
const store = new JsonlInfoRecordStore(tmpDir)

async function classify(text) {
  const result = await handleDeleteIntent(text, store)
  // null = 非删除意图（应交给 LLM 处理）；string = 删除意图（fast path）
  return result
}

async function run() {
  // ---- 反例：普通否定 / 闲聊 ---- 必须不触发删除
  for (const text of [
    '不要编',
    '不要 emoji',
    '不要客气',
    '不要瞎说',
    '具体一点详细一点，不要编，会就是会不会就是不会',
    '嗯',
    '今天天气怎么样',
    '你叫什么名字',
  ]) {
    const r = await classify(text)
    check(`D-非删除: ${text.slice(0, 30)}`, r === null, `got=${JSON.stringify(r)}`)
  }

  // ---- 正例：明确删除动词 + 对象 ---- 必须触发删除
  // 空 store 下都会返回"没找到..."或"没有可删的记录."（string，非 null）
  for (const text of [
    '不要这条记录',
    '删掉测试记录',
    '删除这条记录',
    '清空饮食记录',
    '去掉刚才那条记录',
    '删掉火鸡面',
    '清空记录',
    '把测试记录删掉',
    '不要所有记录',
    '那条记录删掉',
  ]) {
    const r = await classify(text)
    check(`D-删除: ${text.slice(0, 30)}`, typeof r === 'string' && r !== null, `got=${JSON.stringify(r)}`)
  }

  // ---- 总结 ----
  const pass = results.filter((r) => r.ok).length
  const fail = results.filter((r) => !r.ok).length
  console.log(`\n=== ${pass}/${results.length} PASS ===`)
  rmSync(tmpDir, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error('smoke crashed:', err)
  rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
})