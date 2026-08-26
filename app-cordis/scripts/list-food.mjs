// 临时工具：列出 food-agent 档案记录（UTF-8）
import { readFileSync } from 'node:fs'
const file = 'D:/vibeCoding/Project_ORCA/app-cordis/data/records/food-agent.jsonl'
const lines = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() && l.includes('"type":"food-log"'))
console.log('总条数:', lines.length)
lines.forEach((l) => {
  try {
    const r = JSON.parse(l)
    const t = new Date(r.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    const f = r.payload?.food ?? '?'
    const k = r.payload?.kcal ?? '?'
    console.log(`${t} | ${f} | ${k} kcal | conf=${r.confidence ?? '?'} | ${r.source}`)
  } catch {
    console.log('PARSE FAIL:', l.slice(0, 80))
  }
})
