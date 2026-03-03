/**
 * play-from-url IPC Handler
 *
 * 监听渲染进程发来的 `play-from-url` 调用，通过主进程
 * 原生 fetch 绕过 CORS 限制，下载远程 .ea2 / .json 配置文件，
 * 保存到本地临时目录后直接调用 createPlayerWindow 启动放映器。
 */

import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { appLogger } from '../logging/winstonLogger'
import { setSharedConfig } from '../state/sharedConfigStore'
import { createPlayerWindow } from '../windows/playerWindow'
import type { MainContext } from '../runtime/context'

// ----------------------------------------------------------------
// 返回值类型
// ----------------------------------------------------------------
export interface PlayFromUrlResult {
  success: boolean
  error?: string
}

// ----------------------------------------------------------------
// 核心逻辑
// ----------------------------------------------------------------

/**
 * 根据 URL 下载配置文件，校验 JSON 格式，保存到本地，启动放映器。
 * @throws 任何步骤失败都会抛出含明确中文描述的 Error
 */
async function downloadAndPlay(url: string): Promise<void> {
  // 1. 基本参数校验
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('URL 不能为空')
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('URL 必须以 http:// 或 https:// 开头')
  }

  appLogger.info('[play-from-url] 开始下载配置文件: %s', url)

  // 2. 使用 Node.js 原生 fetch 发起请求（主进程天然绕过浏览器 CORS 限制）
  let response: Response
  try {
    response = await fetch(url, {
      // 设置合理的超时：Node 18+ fetch 支持 signal
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err: any) {
    const msg =
      err?.name === 'TimeoutError'
        ? '请求超时（30s），请检查网络或 URL 是否可访问'
        : `网络请求失败：${err?.message ?? err}`
    throw new Error(msg)
  }

  // 3. 验证 HTTP 状态码
  if (!response.ok) {
    throw new Error(
      `服务器返回错误状态码 ${response.status}（${response.statusText}），请确认 URL 地址是否正确`
    )
  }

  // 4. 读取响应文本
  let rawText: string
  try {
    rawText = await response.text()
  } catch (err: any) {
    throw new Error(`读取响应内容失败：${err?.message ?? err}`)
  }

  if (!rawText || !rawText.trim()) {
    throw new Error('服务器返回了空内容，无法解析为考试配置')
  }

  // 5. 解析 JSON（同时兼容 .ea2 和 .json 格式，二者本质都是 JSON）
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new Error('响应内容不是有效的 JSON 格式，请确认 URL 指向的是 .ea2 或 .json 考试配置文件')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('配置文件格式无效：顶层必须是一个 JSON 对象')
  }

  // 6. 将配置序列化（统一格式，防止原始文本中含有 BOM 等异常字符）
  const configJson = JSON.stringify(parsed)

  // 7. 保存到持久化目录 userData/temp_exams/{timestamp}.ea2
  const tempDir = path.join(app.getPath('userData'), 'temp_exams')
  try {
    await fs.promises.mkdir(tempDir, { recursive: true })
  } catch (err: any) {
    throw new Error(`创建临时目录失败：${err?.message ?? err}`)
  }

  const timestamp = Date.now()
  const fileName = `url-${timestamp}.ea2`
  const filePath = path.join(tempDir, fileName)

  try {
    await fs.promises.writeFile(filePath, configJson, 'utf-8')
    appLogger.info('[play-from-url] 配置文件已保存至: %s', filePath)
  } catch (err: any) {
    throw new Error(`写入配置文件失败：${err?.message ?? err}`)
  }

  // 8. 同步到 sharedConfigStore，确保 playerWindow 可通过 IPC get-config 立即获取
  setSharedConfig(configJson)

  // 9. 启动放映器窗口（复用现有逻辑，playerWindow 内部会再次读取文件并 send load-config）
  createPlayerWindow(filePath)

  appLogger.info('[play-from-url] 放映器窗口已创建，配置来源: %s', url)
}

// ----------------------------------------------------------------
// 注册函数（供 ipcHandlers/index.ts 调用）
// ----------------------------------------------------------------

/**
 * 注册 `play-from-url` IPC handler。
 * @param ctx 可选的 MainContext（与现有 handler 保持一致的注册模式）
 * @returns 清理函数
 */
export function registerPlayFromUrlHandler(ctx?: MainContext): () => void {
  const handlerFn = async (
    _event: Electron.IpcMainInvokeEvent,
    url: string
  ): Promise<PlayFromUrlResult> => {
    try {
      await downloadAndPlay(url)
      return { success: true }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err)
      appLogger.error('[play-from-url] 处理失败: %s', message)
      // 返回结构化错误而非直接 throw，方便渲染端区分网络错误 vs 业务错误
      return { success: false, error: message }
    }
  }

  if (ctx) {
    ctx.ipc.handle('play-from-url', handlerFn)
    // ctx 模式下依赖 ctx 自身的生命周期，返回空清理函数
    return () => {}
  } else {
    ipcMain.handle('play-from-url', handlerFn)
    return () => ipcMain.removeHandler('play-from-url')
  }
}
