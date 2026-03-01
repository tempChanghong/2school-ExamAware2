<template>
  <div class="settings-page">
    <h2>集控服务</h2>
    <t-space direction="vertical" size="small" style="width: 100%">
      <t-card :title="'集控服务'" theme="poster2">
        <!-- 启用开关 -->
        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="server" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">启用集控</div>
            <div class="settings-item-desc">
              连接到公网集控服务器，接收远程下发的考试配置、时间同步和设置变更指令。
            </div>
          </div>
          <div class="settings-item-action">
            <t-switch
              v-model="enabled"
              :label="[
                { value: true, label: '开' },
                { value: false, label: '关' }
              ]"
            />
          </div>
        </div>

        <t-divider />

        <!-- 服务器地址 -->
        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="link" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">服务器地址</div>
            <div class="settings-item-desc">
              集控服务器的 WebSocket 地址，需以 <code>wss://</code> 或 <code>ws://</code> 开头。
            </div>
          </div>
          <div class="settings-item-action" style="min-width: 280px">
            <t-input
              v-model="serverUrl"
              :disabled="!enabled"
              placeholder="wss://exam.newfires.top/ws"
              clearable
            />
          </div>
        </div>

        <t-divider />

        <!-- 客户端名称 -->
        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="desktop" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">客户端名称</div>
            <div class="settings-item-desc">
              在集控面板中的显示名称，方便管理员辨识。留空则使用设备 ID。
            </div>
          </div>
          <div class="settings-item-action" style="min-width: 200px">
            <t-input
              v-model="clientName"
              :disabled="!enabled"
              placeholder="如：高三 1 班教室"
              clearable
            />
          </div>
        </div>

        <t-divider />

        <!-- 连接状态 -->
        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="chart-line" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">连接状态</div>
            <div class="settings-item-desc">
              主进程会根据上方配置自动连接和断开。修改配置后将自动重连。
            </div>
            <div style="margin-top: 6px">
              <t-tag :theme="statusTheme" variant="light-outline">
                {{ statusLabel }}
              </t-tag>
            </div>
          </div>
        </div>

        <t-divider />

        <!-- 本地存储 -->
        <div class="settings-item">
          <div class="settings-item-icon">
            <TIcon name="folder-open" size="22px" />
          </div>
          <div class="settings-item-main">
            <div class="settings-item-title">本地存储目录</div>
            <div class="settings-item-desc">
              查看通过集控服务器下发并持久化保存在本地的考试配置文件。
            </div>
          </div>
          <div class="settings-item-action">
            <t-button variant="outline" @click="handleOpenDir">
              <template #icon><TIcon name="folder" /></template>
              打开目录
            </t-button>
          </div>
        </div>
      </t-card>
    </t-space>
  </div>
</template>

<script setup lang="ts">
import { Icon as TIcon } from 'tdesign-icons-vue-next'
import { useSettingRef } from '@renderer/composables/useSetting'
import { useCentralControl } from '@renderer/composables/useCentralControl'

// ===== 配置绑定 =====
// enabled 立即保存（开关体验）
const enabled = useSettingRef<boolean>('centralControl.enabled', false)

// serverUrl 使用 800ms 防抖，避免用户输入过程中频繁触发后端重连
const serverUrl = useSettingRef<string>('centralControl.serverUrl', '', { debounce: 800 })

// clientName 使用 600ms 防抖
const clientName = useSettingRef<string>('centralControl.clientName', '', { debounce: 600 })

// ===== 连接状态（只读） =====
const { statusLabel, statusTheme } = useCentralControl()

const handleOpenDir = async () => {
  try {
    await window.api.centralControl.openDir()
  } catch (error) {
    console.error('Failed to open persistent config directory:', error)
  }
}
</script>
