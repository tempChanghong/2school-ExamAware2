/**
 * updaterService.ts
 *
 * 静默热更新服务（Silent OTA Updater Service）
 *
 * 功能概述：
 *   1. 封装 electron-updater 的 autoUpdater 生命周期管理
 *   2. 自动后台下载新版本（autoDownload = true），不弹出任何 UI
 *   3. 在应用退出时自动安装（autoInstallOnAppQuit = true）
 *   4. 对外暴露 checkAndUpdate(immediate) 接口，供集控指令调用：
 *      - immediate = false：仅后台下载，等应用关闭时自动替换
 *      - immediate = true：下载完成后立即调用 quitAndInstall() 静默重启
 *   5. 全面的事件监听与日志记录，所有关键生命周期都有 appLogger 输出
 *
 * 注意：
 *   - 生产环境（app.isPackaged）：读取 electron-builder.yml 中的 publish 配置
 *   - 开发环境（!app.isPackaged）：读取 dev-app-update.yml，需要手动指定测试服务器
 *   - `app.isPackaged` 判断确保开发环境下不会意外触发生产更新
 */

import { app } from 'electron'
import path from 'path'
// electron-updater 是 CommonJS 模块，在 ESM 项目中必须通过默认导入解构使用
// 直接使用具名导入（import { autoUpdater }）在运行时会报 SyntaxError
import electronUpdaterPkg from 'electron-updater'
const { autoUpdater } = electronUpdaterPkg
import { appLogger } from './logging/winstonLogger'

const LOG_TAG = '[UpdaterService]'

// ============================================================================
// 内部状态
// ============================================================================

/** 是否已初始化（防止重复注册事件监听器） */
let initialized = false

/**
 * "立即重启"模式的 pending 标志。
 * 当集控指令携带 immediate=true 时设置为 true，
 * 在 update-downloaded 事件触发时检查此标志并执行 quitAndInstall()。
 */
let pendingImmediateInstall = false

// ============================================================================
// 初始化
// ============================================================================

/**
 * 初始化更新服务。在 app.whenReady() 中调用一次。
 *
 * 核心配置：
 *   - autoDownload = true：有可用更新时自动后台下载，不打断用户
 *   - autoInstallOnAppQuit = true：用户正常关闭应用时自动应用更新
 *   - allowPrerelease = false：生产环境只接收正式版本
 *
 * 开发模式处理：
 *   - 将 updateConfigPath 指向 dev-app-update.yml（位于 packages/desktop 根目录）
 *   - 在开发模式下不实际触发更新检查（避免误操作），除非环境变量 FORCE_UPDATER=1
 */
export function initUpdater(): void {
  // 防止重复初始化
  if (initialized) {
    appLogger.warn(`${LOG_TAG} initUpdater() 被重复调用，已忽略`)
    return
  }
  initialized = true

  try {
    // ----- 基础配置 -----
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    // 禁用自动提示框，完全无感知更新
    autoUpdater.autoRunAppAfterInstall = true

    // 开发模式：指向项目内的 dev-app-update.yml 作为测试配置
    if (!app.isPackaged) {
      // __dirname 在编译后为 dist/main，向上两级到 packages/desktop
      const devConfigPath = path.join(__dirname, '../../dev-app-update.yml')
      autoUpdater.updateConfigPath = devConfigPath
      appLogger.info(`${LOG_TAG} [DEV] 更新配置指向: ${devConfigPath}`)
      appLogger.info(
        `${LOG_TAG} [DEV] 开发模式下跳过自动检查。如需测试，可发送 UPDATE_SOFTWARE 集控指令手动触发。`
      )
    }

    // ----- 注册事件监听器 -----
    registerUpdaterEvents()

    appLogger.info(
      `${LOG_TAG} 更新服务初始化完成 (isPackaged=${app.isPackaged}, autoDownload=true, autoInstallOnAppQuit=true)`
    )
  } catch (error) {
    appLogger.error(`${LOG_TAG} 初始化失败`, error as Error)
  }
}

// ============================================================================
// 事件监听器
// ============================================================================

/**
 * 注册 autoUpdater 的所有关键生命周期事件。
 * 所有事件均有日志记录，不弹出任何 UI 对话框。
 */
function registerUpdaterEvents(): void {
  // 正在检查更新
  autoUpdater.on('checking-for-update', () => {
    appLogger.info(`${LOG_TAG} 正在检查更新...`)
  })

  // 发现可用更新
  autoUpdater.on('update-available', (info) => {
    appLogger.info(
      `${LOG_TAG} 发现新版本: ${info.version} (当前: ${app.getVersion()})，开始后台下载...`
    )
  })

  // 当前已是最新版本
  autoUpdater.on('update-not-available', (info) => {
    appLogger.info(`${LOG_TAG} 当前已是最新版本: ${info.version}`)
    // 检查完毕后不需要立即安装，重置标志
    pendingImmediateInstall = false
  })

  // 下载进度（仅在日志级别为 debug 时打印，避免刷屏）
  autoUpdater.on('download-progress', (progress) => {
    appLogger.debug(
      `${LOG_TAG} 下载进度: ${progress.percent.toFixed(1)}% ` +
        `(速度: ${formatBytes(progress.bytesPerSecond)}/s, ` +
        `已下载: ${formatBytes(progress.transferred)}/${formatBytes(progress.total)})`
    )
  })

  // 下载完成
  autoUpdater.on('update-downloaded', (info) => {
    appLogger.info(
      `${LOG_TAG} 新版本 ${info.version} 下载完成。` +
        (pendingImmediateInstall
          ? '检测到 immediate=true 指令，将立即重启安装...'
          : '将在下次应用退出时自动安装。')
    )

    if (pendingImmediateInstall) {
      // 重置标志，防止后续事件误触发
      pendingImmediateInstall = false

      // 延迟 1 秒执行，给日志写入留出时间
      setTimeout(() => {
        try {
          appLogger.info(`${LOG_TAG} 执行 quitAndInstall()，应用即将重启...`)
          // isSilent=false（Windows 安装器静默模式），isForceRunAfter=true（安装完成后自动重启）
          autoUpdater.quitAndInstall(false, true)
        } catch (quitError) {
          appLogger.error(`${LOG_TAG} quitAndInstall() 执行失败`, quitError as Error)
        }
      }, 1000)
    }
  })

  // 更新错误
  autoUpdater.on('error', (error) => {
    // 重置立即安装标志，防止错误后状态残留
    pendingImmediateInstall = false
    appLogger.error(`${LOG_TAG} 更新检查/下载出错`, error as Error)
  })
}

// ============================================================================
// 公共 API —— 供集控指令调用
// ============================================================================

/**
 * 触发更新检查（并在 autoDownload=true 下自动下载）。
 * 由集控指令 UPDATE_SOFTWARE 调用。
 *
 * @param immediate
 *   - false（默认）：后台静默下载，等应用退出时自动安装，不打断考试
 *   - true：下载完成后立即调用 quitAndInstall()，强制重启（请确认考试已结束）
 *
 * @returns Promise<void>，调用方无需等待（fire-and-forget 模式）
 */
export async function checkAndUpdate(immediate: boolean = false): Promise<void> {
  try {
    appLogger.info(`${LOG_TAG} 收到更新指令 (immediate=${immediate})，开始检查更新...`)

    // 标记是否需要立即安装（在 update-downloaded 事件中检查）
    pendingImmediateInstall = immediate

    // 发起检查（electron-updater 会自动处理后续下载流程）
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // 重置标志，防止错误后 pendingImmediateInstall 残留为 true
    pendingImmediateInstall = false
    appLogger.error(`${LOG_TAG} checkForUpdates() 失败`, error as Error)
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将字节数格式化为人类可读字符串（用于日志输出）。
 * @param bytes 字节数
 * @returns 格式化字符串，例如 "1.5 MB"
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
