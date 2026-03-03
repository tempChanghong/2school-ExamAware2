/**
 * bootConfig.ts
 *
 * 开机启动相关配置的类型定义。
 * 本模块被主进程 (bootService.ts) 和渲染进程 (设置页) 共享引用。
 */

/**
 * 开机启动配置接口，对应 configStore 中 `boot` 字段的结构。
 *
 * 存储示例（userData/config.json）：
 * ```json
 * {
 *   "boot": {
 *     "autoStart": true,
 *     "startHidden": true
 *   }
 * }
 * ```
 */
export interface BootConfig {
  /**
   * 是否开机自动启动应用。
   * - true：注册到操作系统的登录项（Windows 注册表 / macOS LaunchAgent）
   * - false：从登录项中移除
   * @default false
   */
  autoStart: boolean

  /**
   * 开机自启时是否隐藏主窗口（静默驻留托盘区）。
   * 仅在 autoStart = true 时有意义；如果 autoStart = false 此字段被忽略。
   * - true：Windows 传递 --hidden 启动参数，macOS 使用 openAsHidden
   * - false：正常显示主窗口
   * @default false
   */
  startHidden: boolean
}

/** BootConfig 的默认值，可在 configStore 中 fallback 使用 */
export const DEFAULT_BOOT_CONFIG: Readonly<BootConfig> = {
  autoStart: false,
  startHidden: false
}
