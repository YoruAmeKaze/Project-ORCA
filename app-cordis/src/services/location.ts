import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import type { ActionHandler, ActionResult } from '../types/action.js'
import type { Decision } from '../types/decision.js'
import type { OrcaLocationConfig } from '../config.js'

export interface LocationFix {
  latitude: number
  longitude: number
  accuracyMeters: number
}

/** Coordinates are held only in this in-memory service and are never returned in ActionResult. */
export interface LocationSnapshot extends LocationFix {
  capturedAt: number
  expiresAt: number
}

export interface LocationService {
  getCurrent(): Promise<LocationSnapshot>
  getLatest(): LocationSnapshot | undefined
  clear(): void
}

type LocationReader = (timeoutMs: number) => Promise<LocationFix>

const WINDOWS_LOCATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$watcher = $null
try {
  Add-Type -AssemblyName System.Device -ErrorAction Stop
  $watcher = New-Object System.Device.Location.GeoCoordinateWatcher
  $ready = $watcher.TryStart($false, [TimeSpan]::FromSeconds(__TIMEOUT_SECONDS__))
  if ($ready) {
    $position = $watcher.Position.Location
    if ($position.IsUnknown) {
      $payload = @{ status = 'unavailable' }
    } else {
      $payload = @{
        status = 'ok'
        latitude = [double]$position.Latitude
        longitude = [double]$position.Longitude
        accuracyMeters = [double]$position.HorizontalAccuracy
      }
    }
  } elseif ($watcher.Status.ToString() -eq 'Disabled') {
    $payload = @{ status = 'permission-denied' }
  } else {
    $payload = @{ status = 'unavailable' }
  }
} catch {
  $payload = @{ status = 'unavailable' }
} finally {
  if ($null -ne $watcher) { try { $watcher.Stop() } catch {} }
}
[Console]::Out.Write(($payload | ConvertTo-Json -Compress))
`

async function readWindowsLocation(timeoutMs: number): Promise<LocationFix> {
  if (platform() !== 'win32') throw new Error('当前系统不支持 Windows 定位服务')

  const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const windowsPowerShell = resolve(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const executable = existsSync(windowsPowerShell) ? windowsPowerShell : 'pwsh.exe'
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const script = WINDOWS_LOCATION_SCRIPT.replace('__TIMEOUT_SECONDS__', String(timeoutSeconds))
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs + 3_000,
      maxBuffer: 8 * 1024,
    }, (error, output) => {
      if (error) {
        reject(new Error('Windows 定位服务无法启动或未能及时响应'))
        return
      }
      resolveOutput(output)
    })
  })

  let result: Record<string, unknown>
  try {
    result = JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch {
    throw new Error('Windows 定位服务返回了无法识别的结果')
  }
  if (result.status === 'permission-denied') {
    throw new Error('Windows 定位未开启或未授予权限。请在系统隐私设置中启用定位后重试。')
  }
  if (result.status !== 'ok') throw new Error('暂时无法获取设备位置，请检查系统定位服务和定位权限后重试。')
  return {
    latitude: Number(result.latitude),
    longitude: Number(result.longitude),
    accuracyMeters: Number(result.accuracyMeters),
  }
}

function validFix(fix: LocationFix): boolean {
  return Number.isFinite(fix.latitude) && fix.latitude >= -90 && fix.latitude <= 90
    && Number.isFinite(fix.longitude) && fix.longitude >= -180 && fix.longitude <= 180
    && Number.isFinite(fix.accuracyMeters) && fix.accuracyMeters >= 0
}

export function createLocationService(
  config: OrcaLocationConfig,
  options: { read?: LocationReader; now?: () => number } = {},
): LocationService {
  const read = options.read ?? readWindowsLocation
  const now = options.now ?? Date.now
  const timeoutMs = Math.min(Math.max(config.timeoutMs || 10_000, 1_000), 30_000)
  const cacheTtlMs = Math.min(Math.max(config.cacheTtlMs || 5 * 60_000, 1_000), 15 * 60_000)
  let latest: LocationSnapshot | undefined

  return {
    async getCurrent() {
      latest = undefined
      const fix = await read(timeoutMs)
      if (!validFix(fix)) throw new Error('定位服务返回的坐标或精度无效。')
      const capturedAt = now()
      latest = { ...fix, capturedAt, expiresAt: capturedAt + cacheTtlMs }
      return { ...latest }
    },
    getLatest() {
      if (!latest || now() >= latest.expiresAt) {
        latest = undefined
        return undefined
      }
      return { ...latest }
    },
    clear() { latest = undefined },
  }
}

function parseNoArguments(reason: string): boolean {
  try {
    const args: unknown = JSON.parse(reason)
    return typeof args === 'object' && args !== null && !Array.isArray(args) && Object.keys(args).length === 0
  } catch {
    return false
  }
}

export function createCurrentLocationHandler(location: LocationService): ActionHandler {
  return {
    name: 'location.current',
    action: 'location.current',
    llmDescription: '获取本机当前定位，供后续需要当前位置的附近查询使用。只在用户请求涉及当前位置或附近地点时调用；无参数，JSON 参数为 {}。精确坐标不会返回给对话或写入日志。',
    async execute(decision: Decision): Promise<ActionResult> {
      if (!parseNoArguments(decision.reason)) {
        return {
          success: false,
          action: decision.action,
          decisionId: decision.decisionId,
          sourceEventId: decision.eventId,
          error: 'location.current 不接受参数',
          message: '读取当前位置的参数格式无效。',
          executedAt: Date.now(),
        }
      }

      try {
        const snapshot = await location.getCurrent()
        const ttlMinutes = Math.max(1, Math.round((snapshot.expiresAt - snapshot.capturedAt) / 60_000))
        return {
          success: true,
          action: decision.action,
          decisionId: decision.decisionId,
          sourceEventId: decision.eventId,
          message: `已获取本机当前位置，可用于附近查询；定位精度约 ${Math.round(snapshot.accuracyMeters)} 米，有效期约 ${ttlMinutes} 分钟。精确坐标仅在内存中供后续查询使用。`,
          metadata: { accuracyMeters: Math.round(snapshot.accuracyMeters), capturedAt: snapshot.capturedAt, expiresAt: snapshot.expiresAt },
          executedAt: Date.now(),
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : '定位服务不可用'
        return {
          success: false,
          action: decision.action,
          decisionId: decision.decisionId,
          sourceEventId: decision.eventId,
          error: detail,
          message: detail,
          executedAt: Date.now(),
        }
      }
    },
  }
}
