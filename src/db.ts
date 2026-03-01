/**
 * db.ts
 *
 * SQLite 数据库层 —— 使用 better-sqlite3
 *
 * 职责：
 *   1. 初始化数据库文件和 devices 表
 *   2. 提供预编译 SQL 语句的辅助方法
 */

import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

// ============================================================================
// 类型定义
// ============================================================================

export interface DeviceRow {
  deviceId: string
  clientName: string
  status: 'ONLINE' | 'OFFLINE'
  ipAddress: string
  appVersion: string
  platform: string
  lastHeartbeat: number
}

export interface AdminRow {
  id: number
  username: string
  password_hash: string
  created_at: number
}

// ============================================================================
// 数据库初始化
// ============================================================================

const DB_DIR = path.resolve(process.cwd(), 'data')
const DB_PATH = path.join(DB_DIR, 'central-control.db')

// 确保数据目录存在
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

const db = new Database(DB_PATH)

// 启用 WAL 模式以提升并发读写性能
db.pragma('journal_mode = WAL')

// 创建 devices 表
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    deviceId      TEXT PRIMARY KEY,
    clientName    TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'OFFLINE',
    ipAddress     TEXT DEFAULT '',
    appVersion    TEXT DEFAULT '',
    platform      TEXT DEFAULT '',
    lastHeartbeat INTEGER NOT NULL DEFAULT 0
  );
`)

// 创建 admins 表
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
`)

// ============================================================================
// 预编译语句
// ============================================================================

const stmtUpsert = db.prepare(`
  INSERT INTO devices (deviceId, clientName, status, ipAddress, appVersion, platform, lastHeartbeat)
  VALUES (@deviceId, @clientName, @status, @ipAddress, @appVersion, @platform, @lastHeartbeat)
  ON CONFLICT(deviceId) DO UPDATE SET
    clientName    = @clientName,
    status        = @status,
    ipAddress     = @ipAddress,
    appVersion    = @appVersion,
    platform      = @platform,
    lastHeartbeat = @lastHeartbeat
`)

const stmtUpdateHeartbeat = db.prepare(`
  UPDATE devices SET lastHeartbeat = @lastHeartbeat, status = 'ONLINE' WHERE deviceId = @deviceId
`)

const stmtSetOffline = db.prepare(`
  UPDATE devices SET status = 'OFFLINE' WHERE deviceId = @deviceId
`)

const stmtGetAll = db.prepare(`SELECT * FROM devices ORDER BY lastHeartbeat DESC`)

const stmtGetOne = db.prepare(`SELECT * FROM devices WHERE deviceId = ?`)

// Admins prepared statements
const stmtInsertAdmin = db.prepare(`
  INSERT INTO admins (username, password_hash, created_at)
  VALUES (@username, @password_hash, @created_at)
`)

const stmtGetAdminByUsername = db.prepare(`
  SELECT * FROM admins WHERE username = ?
`)

const stmtCheckHasAdmins = db.prepare(`
  SELECT COUNT(*) as count FROM admins
`)

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 注册或更新设备信息（INSERT ... ON CONFLICT UPDATE）
 */
export function upsertDevice(device: DeviceRow): void {
  stmtUpsert.run(device)
}

/**
 * 更新设备心跳时间戳，同时将状态设为 ONLINE
 */
export function updateHeartbeat(deviceId: string, timestamp: number): void {
  stmtUpdateHeartbeat.run({ deviceId, lastHeartbeat: timestamp })
}

/**
 * 将设备状态标记为 OFFLINE
 */
export function setDeviceOffline(deviceId: string): void {
  stmtSetOffline.run({ deviceId })
}

/**
 * 获取所有设备列表
 */
export function getAllDevices(): DeviceRow[] {
  return stmtGetAll.all() as DeviceRow[]
}

/**
 * 根据 deviceId 获取单个设备
 */
export function getDevice(deviceId: string): DeviceRow | undefined {
  return stmtGetOne.get(deviceId) as DeviceRow | undefined
}

// ----------------------------------------------------------------------------
// Admin 函数
// ----------------------------------------------------------------------------

/**
 * 创建新管理员
 */
export function createAdmin(username: string, passwordHash: string): void {
  stmtInsertAdmin.run({
    username,
    password_hash: passwordHash,
    created_at: Date.now()
  })
}

/**
 * 根据用户名获取管理员
 */
export function getAdminByUsername(username: string): AdminRow | undefined {
  return stmtGetAdminByUsername.get(username) as AdminRow | undefined
}

/**
 * 检查数据库中是否已存在管理员
 */
export function hasAnyAdmin(): boolean {
  const row = stmtCheckHasAdmins.get() as { count: number }
  return row.count > 0
}

/**
 * 关闭数据库连接（进程退出时调用）
 */
export function closeDatabase(): void {
  db.close()
}
