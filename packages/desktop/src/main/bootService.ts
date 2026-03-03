/**
 * bootService.ts
 *
 * 开机自动启动服务（Boot Auto-Start Service）
 *
 * 功能概述：
 *   1. 从 configStore 读取 `boot.*` 配置（autoStart / startHidden）
 *   2. 调用 app.setLoginItemSettings() 向操作系统注册/注销开机登录项
 *   3. 处理跨平台差异：
 *      - Windows：通过附加 --hidden 命令行参数实现隐窗启动
 *      - macOS：使用 openAsHidden 原生选项实现隐窗启动
 *      - Linux：开机自启功能不稳定，仅打印警告日志，不做强制注册
 *   4. 判断当前是否为"开机自启 + 隐藏窗口"启动模式（供 index.ts 决定是否显示主窗口）
 */

import { app } from 'electron'
import { getConfig } from './configStore'
import { appLogger } from './logging/winstonLogger'
import type { BootConfig } from '../shared/types/bootConfig'
import { DEFAULT_BOOT_CONFIG } from '../shared/types/bootConfig'

const LOG_TAG = '[BootService]'

// ============================================================================
// 配置读取
// ============================================================================

/**
 * 从 configStore 安全读取 boot 配置，缺失字段自动 fallback 到默认值。
 * @returns 完整的 BootConfig 对象
 */
export function readBootConfig(): BootConfig {
  try {
    const raw = getConfig('boot') ?? {}
    return {
      autoStart: typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULT_BOOT_CONFIG.autoStart,
      startHidden:
        typeof raw.startHidden === 'boolean' ? raw.startHidden : DEFAULT_BOOT_CONFIG.startHidden
    }
  } catch (error) {
    appLogger.error(`${LOG_TAG} 读取 boot 配置失败，使用默认值`, error as Error)
    return { ...DEFAULT_BOOT_CONFIG }
  }
}

// ============================================================================
// 跨平台登录项注册
// ============================================================================

/**
 * 根据 BootConfig 向操作系统注册或注销开机启动项。
 *
 * 跨平台行为：
 *   - Windows：写入 HKCU\Software\Microsoft\Windows\CurrentVersion\Run，
 *              startHidden 时附加 --hidden 参数到启动命令
 *   - macOS：通过 LaunchAgent plist 控制，openAsHidden 由系统负责隐藏窗口
 *   - Linux：日志警告，不做处理（systemd 用户级支持不稳定）
 *
 * @param cfg 目标 BootConfig，通常来自 readBootConfig() 或用户设置更新
 */
export function applyAutoStart(cfg: BootConfig): void {
  try {
    const { autoStart, startHidden } = cfg

    if (process.platform === 'linux') {
      // Linux 的 setLoginItemSettings 需要 systemd 支持，且不同发行版行为差异大
      // 本期暂不做强制注册，仅记录警告；可在未来版本通过写 ~/.config/autostart/ 实现
      appLogger.warn(
        `${LOG_TAG} Linux 平台暂不支持通过 API 注册开机启动项。` +
          `如需自启，请手动在 ~/.config/autostart/ 创建 .desktop 文件。`
      )
      return
    }

    if (process.platform === 'win32') {
      applyAutoStartWindows(autoStart, startHidden)
    } else if (process.platform === 'darwin') {
      applyAutoStartMacOS(autoStart, startHidden)
    }
  } catch (error) {
    appLogger.error(`${LOG_TAG} 应用开机自启配置失败`, error as Error)
  }
}

/**
 * Windows 平台登录项注册。
 *
 * 原理：
 *   - 打包后（isPackaged）：直接使用 process.execPath 作为可执行路径
 *   - 开发模式（!isPackaged）：electron CLI 本身是 process.execPath，
 *     需要同时传入 process.argv[1]（入口脚本路径），再附加 --hidden
 *
 * @param autoStart 是否开机自启
 * @param startHidden 开机自启时是否隐藏窗口
 */
function applyAutoStartWindows(autoStart: boolean, startHidden: boolean): void {
  try {
    // 构造附加参数：startHidden 时传 --hidden，方便 index.ts 通过 process.argv 检测
    const extraArgs: string[] = startHidden ? ['--hidden'] : []

    if (app.isPackaged) {
      // 正式打包版本：execPath 即应用可执行文件，直接注册
      app.setLoginItemSettings({
        openAtLogin: autoStart,
        args: extraArgs
      })
    } else {
      // 开发模式：execPath 是 electron 可执行文件，需要附加入口脚本路径
      // 注意：process.argv[1] 通常为 dist/main/index.js 或 src/main/index.ts
      const devEntryPath = process.argv[1] ?? ''
      app.setLoginItemSettings({
        openAtLogin: autoStart,
        path: process.execPath,
        args: devEntryPath ? [devEntryPath, ...extraArgs] : extraArgs
      })
    }

    appLogger.info(
      `${LOG_TAG} [Windows] 登录项已${autoStart ? '注册' : '注销'}` +
        (autoStart ? `，startHidden=${startHidden}` : '')
    )
  } catch (error) {
    appLogger.error(`${LOG_TAG} [Windows] 设置登录项失败`, error as Error)
  }
}

/**
 * macOS 平台登录项注册。
 *
 * 原理：
 *   - openAsHidden：让 Dock 在应用启动时不弹出，同时不调用 mainWindow.show()
 *     即可实现完全的"驻留后台"效果
 *
 * @param autoStart 是否开机自启
 * @param startHidden 开机自启时是否隐藏窗口
 */
function applyAutoStartMacOS(autoStart: boolean, startHidden: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      // macOS 独有选项：openAsHidden 告知系统启动时不在 Dock 激活展示
      openAsHidden: autoStart && startHidden
    })

    appLogger.info(
      `${LOG_TAG} [macOS] 登录项已${autoStart ? '注册' : '注销'}` +
        (autoStart ? `，openAsHidden=${autoStart && startHidden}` : '')
    )
  } catch (error) {
    appLogger.error(`${LOG_TAG} [macOS] 设置登录项失败`, error as Error)
  }
}

// ============================================================================
// 启动模式检测
// ============================================================================

/**
 * 检测当前是否应以"隐藏窗口"模式运行（驻留托盘，不显示主界面）。
 *
 * 触发条件（满足其一即可）：
 *   1. 命令行包含 --hidden 参数（由 Windows 登录项注册时传入）
 *   2. macOS 系统检测到应用以 wasOpenedAsHidden 方式打开
 *   3. 当前是开机自启场景（isAutoStart = true）且配置了 startHidden = true
 *
 * @param isAutoStart 当前是否为开机自启场景（由 index.ts 传入）
 * @returns 是否应以隐藏窗口模式运行
 */
export function shouldStartHidden(isAutoStart: boolean): boolean {
  try {
    // 条件 1：命令行参数（Windows 登录项注册的 --hidden）
    if (process.argv.includes('--hidden')) {
      appLogger.info(`${LOG_TAG} 检测到 --hidden 参数，将以隐窗模式运行`)
      return true
    }

    // 条件 2：macOS 系统的 wasOpenedAsHidden 标志
    if (process.platform === 'darwin') {
      try {
        const settings = app.getLoginItemSettings?.()
        if (settings && (settings as any).wasOpenedAsHidden) {
          appLogger.info(`${LOG_TAG} [macOS] wasOpenedAsHidden=true，将以隐窗模式运行`)
          return true
        }
      } catch {
        // 不支持时忽略
      }
    }

    // 条件 3：开机自启 + 用户配置了 startHidden
    if (isAutoStart) {
      const cfg = readBootConfig()
      if (cfg.startHidden) {
        appLogger.info(`${LOG_TAG} 开机自启且 startHidden=true，将以隐窗模式运行`)
        return true
      }
    }

    return false
  } catch (error) {
    appLogger.error(`${LOG_TAG} 检测隐窗模式失败，默认不隐藏`, error as Error)
    return false
  }
}
