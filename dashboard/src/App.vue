<script setup lang="ts">
/**
 * App.vue — ExamAware2 集控管理大屏
 *
 * 功能：
 *   1. 设备网格：卡片式展示所有终端的在线状态，每 3 秒自动刷新
 *   2. 全局控制面板：时间同步 / 下发配置 / 修改设置 广播指令
 */

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import axios from 'axios'
import SchoolLogo from './icons/school.png'

// ============================================================================
// 类型定义
// ============================================================================

interface Device {
  deviceId: string
  clientName: string
  status: 'ONLINE' | 'OFFLINE'
  ipAddress: string
  appVersion: string
  platform: string
  lastHeartbeat: number
}

interface ApiResponse<T> {
  success: boolean
  data: T
  total: number
}

interface CommandResponse {
  success: boolean
  message: string
  sentCount?: number
  error?: string
}

// ============================================================================
// 配置
// ============================================================================

const API_BASE = 'http://localhost:3000'
const POLL_INTERVAL_MS = 3000

const api = axios.create({
  baseURL: API_BASE,
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' }
})

// ============================================================================
// 响应式状态
// ============================================================================

const devices = ref<Device[]>([])
const loading = ref(true)
const lastUpdated = ref<Date | null>(null)
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null)

// -- 认证状态 --
const token = ref(localStorage.getItem('ea2_admin_token') || '')
const isLoggedIn = computed(() => !!token.value)
const loginForm = ref({ username: '', password: '' })
const loginLoading = ref(false)

function handleLogout() {
  token.value = ''
  localStorage.removeItem('ea2_admin_token')
  if (pollTimer.value) {
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }
  devices.value = []
  lastUpdated.value = null
  ElMessage.info('已退出登录')
}

// -- Axios 拦截器 --
api.interceptors.request.use(config => {
  if (token.value) {
    config.headers.Authorization = `Bearer ${token.value}`
  }
  return config
})

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      if (token.value) {
        ElMessage.warning('会话已过期或权限不足，请重新登录')
        handleLogout()
      }
    }
    return Promise.reject(err)
  }
)

// -- 对话框状态 --
const syncTimeDialogVisible = ref(false)
const syncOffsetSeconds = ref(0)

const pushConfigDialogVisible = ref(false)
const pushConfigAutoPlay = ref(true)
const pushConfigLoading = ref(false)
const pushConfigFileList = ref<UploadFile[]>([])


const updateSettingsDialogVisible = ref(false)
const settingsJson = ref('{\n  \n}')

const addAdminDialogVisible = ref(false)
const addAdminForm = ref({ username: '', password: '' })
const addAdminLoading = ref(false)

// ============================================================================
// 计算属性
// ============================================================================

const onlineCount = computed(() => devices.value.filter(d => d.status === 'ONLINE').length)
const offlineCount = computed(() => devices.value.filter(d => d.status === 'OFFLINE').length)
const totalCount = computed(() => devices.value.length)

// ============================================================================
// API 调用
// ============================================================================

async function fetchDevices() {
  try {
    const { data } = await api.get<ApiResponse<Device[]>>('/api/devices')
    if (data.success) {
      devices.value = data.data
      lastUpdated.value = new Date()
    }
  } catch (err: any) {
    console.error('[Dashboard] 获取设备列表失败:', err.message)
  } finally {
    loading.value = false
  }
}

async function broadcastCommand(action: string, payload: Record<string, any>) {
  try {
    const { data } = await api.post<CommandResponse>('/api/broadcast', { action, payload })
    if (data.success) {
      ElMessage.success(data.message)
    } else {
      ElMessage.error(data.error ?? '指令发送失败')
    }
    return data
  } catch (err: any) {
    ElMessage.error(`广播失败: ${err.message}`)
    return null
  }
}

async function sendCommandToDevice(deviceId: string, action: string, payload: Record<string, any>) {
  try {
    const { data } = await api.post<CommandResponse>(`/api/devices/${deviceId}/command`, { action, payload })
    if (data.success) {
      ElMessage.success(data.message)
    } else {
      ElMessage.error(data.error ?? '指令发送失败')
    }
  } catch (err: any) {
    ElMessage.error(`发送失败: ${err.message}`)
  }
}

// ============================================================================
// 操作逻辑
// ============================================================================

async function handleLogin() {
  if (!loginForm.value.username || !loginForm.value.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }
  loginLoading.value = true
  try {
    const { data } = await api.post('/api/auth/login', loginForm.value)
    if (data.success && data.data.token) {
      token.value = data.data.token
      localStorage.setItem('ea2_admin_token', token.value)
      ElMessage.success('登录成功')
      fetchDevices()
      pollTimer.value = setInterval(fetchDevices, POLL_INTERVAL_MS)
    } else {
      ElMessage.error(data.error || '登录失败')
    }
  } catch (err: any) {
    ElMessage.error(err.response?.data?.error || `登录失败: ${err.message}`)
  } finally {
    loginLoading.value = false
  }
}

function openSyncTimeDialog() {
  syncOffsetSeconds.value = 0
  syncTimeDialogVisible.value = true
}

async function confirmSyncTime() {
  syncTimeDialogVisible.value = false
  await broadcastCommand('SYNC_TIME', {
    offsetSeconds: syncOffsetSeconds.value
  })
}

function openPushConfigDialog() {
  pushConfigFileList.value = []
  pushConfigAutoPlay.value = true
  pushConfigLoading.value = false
  pushConfigDialogVisible.value = true
}

/**
 * 用户在 el-upload 中选择文件后触发的回调
 * 由于 :auto-upload="false"，文件不会被自动上传，仅保存到 fileList 中
 */
function handleUploadChange(file: UploadFile) {
  // el-upload 的 :limit="1" 已限制只能选一个文件；
  // 但为保险起见，再次覆盖列表保证始终只有最新选择的文件
  pushConfigFileList.value = [file]
}

/**
 * 确认下发：使用 FileReader 读取 .ea2 文件内容，然后广播 PUSH_EXAM_CONFIG
 */
async function confirmPushConfig() {
  // ---- 校验 ----
  const uploadFile = pushConfigFileList.value[0]
  if (!uploadFile?.raw) {
    ElMessage.warning('请先选择一个 .ea2 配置文件')
    return
  }

  pushConfigLoading.value = true

  try {
    // ---- 读取文件内容 ----
    const fileContent = await readFileAsText(uploadFile.raw)
    const filename = uploadFile.name || 'central-push.ea2'

    // ---- 调用广播 API ----
    const result = await broadcastCommand('PUSH_EXAM_CONFIG', {
      data: fileContent,
      encoding: 'plain',
      filename,
      autoPlay: pushConfigAutoPlay.value
    })

    if (result?.success) {
      // 成功：关闭弹窗并清空文件列表
      pushConfigDialogVisible.value = false
      pushConfigFileList.value = []
    }
  } catch (err: any) {
    ElMessage.error(`读取文件失败: ${err.message}`)
  } finally {
    pushConfigLoading.value = false
  }
}

/**
 * 将 File 对象以纯文本形式读取（返回 Promise）
 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('FileReader 读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

function openUpdateSettingsDialog() {
  settingsJson.value = '{\n  \n}'
  updateSettingsDialogVisible.value = true
}

async function confirmUpdateSettings() {
  try {
    const settings = JSON.parse(settingsJson.value)
    updateSettingsDialogVisible.value = false
    await broadcastCommand('UPDATE_SETTINGS', { settings })
  } catch {
    ElMessage.error('JSON 格式错误，请检查')
  }
}

function openAddAdminDialog() {
  addAdminForm.value = { username: '', password: '' }
  addAdminDialogVisible.value = true
}

async function confirmAddAdmin() {
  if (!addAdminForm.value.username || !addAdminForm.value.password) {
    ElMessage.warning('请输入新用户名和密码')
    return
  }
  addAdminLoading.value = true
  try {
    const { data } = await api.post('/api/auth/register', addAdminForm.value)
    if (data.success) {
      ElMessage.success('管理员添加成功')
      addAdminDialogVisible.value = false
    } else {
      ElMessage.error(data.error || '添加失败')
    }
  } catch (err: any) {
    ElMessage.error(err.response?.data?.error || `添加请求失败: ${err.message}`)
  } finally {
    addAdminLoading.value = false
  }
}



function formatLastUpdated(): string {
  if (!lastUpdated.value) return '—'
  return lastUpdated.value.toLocaleTimeString('zh-CN')
}

function getTimeSinceHeartbeat(ts: number): string {
  if (!ts) return '—'
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s 前`
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`
  return `${Math.floor(sec / 3600)}h 前`
}

// ============================================================================
// 生命周期
// ============================================================================

onMounted(() => {
  if (isLoggedIn.value) {
    fetchDevices()
    pollTimer.value = setInterval(fetchDevices, POLL_INTERVAL_MS)
  }
})

onUnmounted(() => {
  if (pollTimer.value) {
    clearInterval(pollTimer.value)
  }
})
</script>

<template>
  <div class="app-wrapper">
    <!-- Login View -->
    <div v-if="!isLoggedIn" class="login-container">
      <div class="login-box">
        <div class="login-header">
          <div class="logo-icon-large">
            <img :src="SchoolLogo" alt="School Logo" class="school-logo-large" />
          </div>
          <h2>ExamAware2</h2>
          <p>集控平台登录</p>
        </div>
        <el-form @keyup.enter="handleLogin">
          <el-form-item>
            <el-input v-model="loginForm.username" placeholder="用户名" size="large">
              <template #prefix><el-icon><User /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-form-item>
            <el-input v-model="loginForm.password" type="password" placeholder="密码" show-password size="large">
              <template #prefix><el-icon><Lock /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-button type="primary" size="large" :loading="loginLoading" class="login-btn" @click="handleLogin">
            登 录
          </el-button>
        </el-form>
      </div>
    </div>

    <!-- Dashboard View -->
    <div v-else class="dashboard">
      <!-- ====== Header ====== -->
    <header class="dashboard-header">
      <div class="header-left">
        <div class="logo-area">
          <div class="logo-icon">
            <img :src="SchoolLogo" alt="School Logo" class="school-logo-small" />
          </div>
          <div>
            <h1 class="header-title">ExamAware2</h1>
            <p class="header-subtitle">集控管理大屏</p>
          </div>
        </div>
      </div>

      <div class="header-stats">
        <div class="stat-chip stat-total">
          <el-icon><Cpu /></el-icon>
          <span class="stat-value">{{ totalCount }}</span>
          <span class="stat-label">设备</span>
        </div>
        <div class="stat-chip stat-online">
          <span class="pulse-dot pulse-dot--green"></span>
          <span class="stat-value">{{ onlineCount }}</span>
          <span class="stat-label">在线</span>
        </div>
        <div class="stat-chip stat-offline">
          <span class="pulse-dot pulse-dot--gray"></span>
          <span class="stat-value">{{ offlineCount }}</span>
          <span class="stat-label">离线</span>
        </div>
      </div>

      <div class="header-right">
        <span class="last-update">
          <el-icon><Refresh /></el-icon>
          {{ formatLastUpdated() }}
        </span>
        <el-button type="danger" plain size="small" @click="handleLogout" style="margin-left: 16px;">
          退出登录
        </el-button>
      </div>
    </header>

    <!-- ====== Control Panel ====== -->
    <section class="control-panel">
      <h2 class="section-title">
        <el-icon><Operation /></el-icon>
        <span>全局控制</span>
      </h2>
      <div class="control-buttons">
        <el-button type="primary" size="large" @click="openSyncTimeDialog">
          <el-icon><Timer /></el-icon>
          <span>时间同步</span>
        </el-button>
        <el-button type="warning" size="large" @click="openPushConfigDialog">
          <el-icon><Upload /></el-icon>
          <span>下发配置</span>
        </el-button>
        <el-button type="info" size="large" @click="openUpdateSettingsDialog">
          <el-icon><Setting /></el-icon>
          <span>修改设置</span>
        </el-button>
        <el-button type="success" size="large" @click="openAddAdminDialog" plain>
          <el-icon><User /></el-icon>
          <span>添加管理员</span>
        </el-button>
      </div>
    </section>

    <!-- ====== Device Grid ====== -->
    <section class="device-section">
      <h2 class="section-title">
        <el-icon><Monitor /></el-icon>
        <span>考场终端 ({{ totalCount }})</span>
      </h2>

      <div v-if="loading" class="loading-area">
        <el-icon class="is-loading" :size="48"><Loading /></el-icon>
        <p>正在加载设备列表…</p>
      </div>

      <div v-else-if="devices.length === 0" class="empty-area">
        <el-icon :size="64"><Warning /></el-icon>
        <p>暂无已注册设备</p>
        <p class="empty-hint">启动被控端并连接集控服务器后，设备将自动出现在此处</p>
      </div>

      <div v-else class="device-grid">
        <div
          v-for="device in devices"
          :key="device.deviceId"
          class="device-card"
          :class="{ 'device-card--online': device.status === 'ONLINE' }"
        >
          <!-- Status Indicator -->
          <div class="card-status-bar" :class="device.status === 'ONLINE' ? 'bar--online' : 'bar--offline'"></div>

          <div class="card-body">
            <!-- Header Row -->
            <div class="card-header">
              <h3 class="card-name">{{ device.clientName || device.deviceId }}</h3>
              <el-tag
                :type="device.status === 'ONLINE' ? 'success' : 'info'"
                size="small"
                effect="dark"
                round
              >
                <span class="tag-dot" :class="device.status === 'ONLINE' ? 'dot--green' : 'dot--gray'"></span>
                {{ device.status }}
              </el-tag>
            </div>

            <!-- Info Lines -->
            <div class="card-info">
              <div class="info-row">
                <el-icon><Cpu /></el-icon>
                <span class="info-label">ID</span>
                <span class="info-value">{{ device.deviceId }}</span>
              </div>
              <div class="info-row">
                <el-icon><Position /></el-icon>
                <span class="info-label">IP</span>
                <span class="info-value">{{ device.ipAddress || '—' }}</span>
              </div>
              <div class="info-row">
                <el-icon><Clock /></el-icon>
                <span class="info-label">心跳</span>
                <span class="info-value">{{ getTimeSinceHeartbeat(device.lastHeartbeat) }}</span>
              </div>
              <div class="info-row" v-if="device.appVersion">
                <el-icon><InfoFilled /></el-icon>
                <span class="info-label">版本</span>
                <span class="info-value">{{ device.appVersion }}</span>
              </div>
            </div>

            <!-- Card Actions (visible on hover) -->
            <div class="card-actions">
              <el-button
                size="small"
                type="primary"
                plain
                :disabled="device.status !== 'ONLINE'"
                @click="sendCommandToDevice(device.deviceId, 'SYNC_TIME', { offsetSeconds: 0 })"
              >
                <el-icon><Timer /></el-icon>
                同步时间
              </el-button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ====== Dialogs ====== -->

    <!-- 时间同步对话框 -->
    <el-dialog
      v-model="syncTimeDialogVisible"
      title="时间同步 — 广播"
      width="420"
      :close-on-click-modal="false"
      class="dark-dialog"
    >
      <el-form label-position="top">
        <el-form-item label="偏移秒数 (offsetSeconds)">
          <el-input-number
            v-model="syncOffsetSeconds"
            :step="1"
            :precision="1"
            controls-position="right"
            style="width: 100%"
          />
          <p class="form-hint">正数 = 快进，负数 = 回拨。0 表示与服务器时间同步。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="syncTimeDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmSyncTime">
          <el-icon><Promotion /></el-icon>
          广播同步
        </el-button>
      </template>
    </el-dialog>

    <!-- 下发配置对话框 —— 本地 .ea2 文件上传 -->
    <el-dialog
      v-model="pushConfigDialogVisible"
      title="下发考试配置 — 广播"
      width="560"
      :close-on-click-modal="false"
      class="dark-dialog"
    >
      <el-form label-position="top">
        <!-- 文件选择区域 -->
        <el-form-item label="选择配置文件 (.ea2)">
          <el-upload
            ref="uploadRef"
            v-model:file-list="pushConfigFileList"
            accept=".ea2"
            :limit="1"
            :auto-upload="false"
            :on-change="handleUploadChange"
            :on-exceed="() => ElMessage.warning('只能选择一个文件，请先移除已选文件')"
            drag
            class="ea-upload"
          >
            <el-icon :size="40" class="upload-icon"><Upload /></el-icon>
            <div class="upload-text">将 .ea2 文件拖拽到此处，或 <em>点击选择</em></div>
            <template #tip>
              <div class="upload-tip">仅支持 .ea2 格式的考试配置文件</div>
            </template>
          </el-upload>
        </el-form-item>

        <!-- 自动放映开关 -->
        <el-form-item label="自动放映">
          <el-switch v-model="pushConfigAutoPlay" active-text="下发后自动打开放映窗口" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="pushConfigDialogVisible = false" :disabled="pushConfigLoading">取消</el-button>
        <el-button
          type="warning"
          :loading="pushConfigLoading"
          :disabled="pushConfigFileList.length === 0"
          @click="confirmPushConfig"
        >
          <template #icon><el-icon><Promotion /></el-icon></template>
          确认下发
        </el-button>
      </template>
    </el-dialog>

    <!-- 修改设置对话框 -->
    <el-dialog
      v-model="updateSettingsDialogVisible"
      title="修改应用设置 — 广播"
      width="520"
      :close-on-click-modal="false"
      class="dark-dialog"
    >
      <el-form label-position="top">
        <el-form-item label="设置对象 (JSON)">
          <el-input
            v-model="settingsJson"
            type="textarea"
            :rows="8"
            placeholder='{ "someKey": "someValue" }'
          />
          <p class="form-hint">JSON 对象将通过 UPDATE_SETTINGS 指令合并到所有终端的 configStore 中。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="updateSettingsDialogVisible = false">取消</el-button>
        <el-button type="info" @click="confirmUpdateSettings">
          <el-icon><Promotion /></el-icon>
          广播设置
        </el-button>
      </template>
    </el-dialog>

    <!-- 添加管理员对话框 -->
    <el-dialog
      v-model="addAdminDialogVisible"
      title="添加管理员"
      width="400"
      :close-on-click-modal="false"
      class="dark-dialog"
    >
      <el-form label-position="top" @keyup.enter="confirmAddAdmin">
        <el-form-item label="用户名">
          <el-input v-model="addAdminForm.username" placeholder="输入新管理员用户名">
            <template #prefix><el-icon><User /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="addAdminForm.password" type="password" placeholder="输入密码" show-password>
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addAdminDialogVisible = false" :disabled="addAdminLoading">取消</el-button>
        <el-button type="success" :loading="addAdminLoading" @click="confirmAddAdmin">
          确认添加
        </el-button>
      </template>
    </el-dialog>
    </div> <!-- /dashboard -->
  </div> <!-- /app-wrapper -->
</template>

<style scoped>
/* ============================================================================
   Login View
   ============================================================================ */

.app-wrapper {
  min-height: 100vh;
}

.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at top, #1a2640 0%, var(--ea-bg-primary) 100%);
}

.login-box {
  width: 100%;
  max-width: 380px;
  background: var(--ea-bg-card);
  border: 1px solid var(--ea-border);
  border-radius: calc(var(--ea-radius) * 1.5);
  padding: 40px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
}

.login-header {
  text-align: center;
  margin-bottom: 32px;
}

.logo-icon-large {
  width: 80px;
  height: 80px;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.school-logo-large {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.login-header h2 {
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--ea-text-primary);
  margin-bottom: 4px;
}

.login-header p {
  color: var(--ea-text-muted);
  font-size: 0.9rem;
}

.login-btn {
  width: 100%;
  margin-top: 8px;
  font-weight: 600;
}

/* ============================================================================
   Layout
   ============================================================================ */

.dashboard {
  max-width: 1440px;
  margin: 0 auto;
  padding: 24px 32px 64px;
}

/* ============================================================================
   Header
   ============================================================================ */

.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 28px;
  background: linear-gradient(135deg, var(--ea-bg-card) 0%, #1a2640 100%);
  border: 1px solid var(--ea-border);
  border-radius: var(--ea-radius);
  margin-bottom: 24px;
  gap: 24px;
  flex-wrap: wrap;
}

.header-left {
  display: flex;
  align-items: center;
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.school-logo-small {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.header-title {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ea-text-primary);
  line-height: 1.2;
}

.header-subtitle {
  font-size: 0.82rem;
  color: var(--ea-text-muted);
  margin-top: 2px;
}

/* Stats */
.header-stats {
  display: flex;
  gap: 12px;
}

.stat-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 0.88rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--ea-border);
}

.stat-value {
  font-size: 1.25rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.stat-label {
  color: var(--ea-text-muted);
  font-size: 0.8rem;
}

.stat-online .stat-value {
  color: var(--ea-success);
}

.stat-offline .stat-value {
  color: var(--ea-text-muted);
}

/* Pulse Dot */
.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.pulse-dot--green {
  background: var(--ea-success);
  box-shadow: 0 0 6px var(--ea-success-glow);
  animation: pulse-green 2s ease-in-out infinite;
}

.pulse-dot--gray {
  background: var(--ea-text-muted);
}

@keyframes pulse-green {
  0%, 100% { opacity: 1; box-shadow: 0 0 6px var(--ea-success-glow); }
  50% { opacity: 0.6; box-shadow: 0 0 12px var(--ea-success-glow); }
}

.header-right {
  display: flex;
  align-items: center;
}

.last-update {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ea-text-muted);
  font-size: 0.82rem;
}

/* ============================================================================
   Section Titles
   ============================================================================ */

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--ea-text-secondary);
  margin-bottom: 16px;
}

/* ============================================================================
   Control Panel
   ============================================================================ */

.control-panel {
  padding: 20px 28px;
  background: var(--ea-bg-card);
  border: 1px solid var(--ea-border);
  border-radius: var(--ea-radius);
  margin-bottom: 28px;
}

.control-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.control-buttons .el-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 24px;
  font-weight: 500;
  border-radius: var(--ea-radius-sm);
}

/* ============================================================================
   Device Grid
   ============================================================================ */

.device-section {
  padding: 20px 28px;
  background: var(--ea-bg-card);
  border: 1px solid var(--ea-border);
  border-radius: var(--ea-radius);
}

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

/* -- Card -- */
.device-card {
  position: relative;
  background: var(--ea-bg-secondary);
  border: 1px solid var(--ea-border);
  border-radius: var(--ea-radius);
  overflow: hidden;
  transition: all var(--ea-transition);
}

.device-card:hover {
  border-color: var(--ea-accent);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  transform: translateY(-2px);
}

.device-card--online {
  border-color: rgba(34, 197, 94, 0.2);
}

.device-card--online:hover {
  border-color: var(--ea-success);
  box-shadow: 0 4px 20px rgba(34, 197, 94, 0.12);
}

.card-status-bar {
  height: 3px;
  width: 100%;
}

.bar--online {
  background: linear-gradient(90deg, var(--ea-success), #4ade80);
}

.bar--offline {
  background: var(--ea-text-muted);
  opacity: 0.3;
}

.card-body {
  padding: 18px 20px 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.card-name {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--ea-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.tag-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}

.dot--green {
  background: #4ade80;
}

.dot--gray {
  background: #9ca3af;
}

/* Info Rows */
.card-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.84rem;
  color: var(--ea-text-secondary);
}

.info-row .el-icon {
  color: var(--ea-text-muted);
  font-size: 14px;
  flex-shrink: 0;
}

.info-label {
  color: var(--ea-text-muted);
  min-width: 28px;
}

.info-value {
  color: var(--ea-text-secondary);
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.82rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Card Actions */
.card-actions {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--ea-border);
  opacity: 0;
  transform: translateY(4px);
  transition: all var(--ea-transition);
}

.device-card:hover .card-actions {
  opacity: 1;
  transform: translateY(0);
}

/* ============================================================================
   Loading & Empty States
   ============================================================================ */

.loading-area,
.empty-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 0;
  color: var(--ea-text-muted);
  gap: 12px;
}

.empty-hint {
  font-size: 0.82rem;
  color: var(--ea-text-muted);
  opacity: 0.7;
}

/* ============================================================================
   Dialog
   ============================================================================ */

.form-hint {
  font-size: 0.78rem;
  color: var(--ea-text-muted);
  margin-top: 6px;
}

/* ============================================================================
   Upload Area
   ============================================================================ */

/* 让 el-upload 占满表单宽度 */
.ea-upload {
  width: 100%;
}

.ea-upload :deep(.el-upload-dragger) {
  background: var(--ea-bg-secondary);
  border: 1px dashed var(--ea-border);
  border-radius: var(--ea-radius-sm);
  padding: 32px 20px;
  transition: border-color var(--ea-transition);
}

.ea-upload :deep(.el-upload-dragger:hover) {
  border-color: var(--ea-accent);
}

.ea-upload :deep(.el-upload) {
  width: 100%;
}

.upload-icon {
  color: var(--ea-text-muted);
  margin-bottom: 8px;
}

.upload-text {
  color: var(--ea-text-secondary);
  font-size: 0.9rem;
}

.upload-text em {
  color: var(--ea-accent);
  font-style: normal;
  cursor: pointer;
}

.upload-tip {
  font-size: 0.78rem;
  color: var(--ea-text-muted);
  margin-top: 8px;
}
</style>
