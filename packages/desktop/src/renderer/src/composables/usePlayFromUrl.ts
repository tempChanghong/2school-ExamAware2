/**
 * usePlayFromUrl
 *
 * 封装"从 URL 放映"的完整交互流程：
 *   1. 弹出 URL 输入框（TDesign DialogPlugin + h() vnode 渲染 t-input）
 *   2. 基础正则校验
 *   3. 调用主进程 IPC（window.api.exam.playFromUrl）
 *   4. 全程 loading 遮罩 + 成功/失败 MessagePlugin 提示
 *
 * 设计为纯函数导出（非 Vue setup composable），可在任意上下文调用，
 * 包括 homeButtons.ts 中的 action 回调（非组件 setup 环境）。
 */

import { h, ref } from 'vue'
import { MessagePlugin, DialogPlugin, LoadingPlugin, Input } from 'tdesign-vue-next'

// ----------------------------------------------------------------
// URL 校验正则
// ----------------------------------------------------------------
const URL_REGEX = /^https?:\/\/.+/i

// ----------------------------------------------------------------
// 核心逻辑
// ----------------------------------------------------------------

/**
 * 弹出 URL 输入对话框并执行"从 URL 放映"流程。
 * 可以在任意上下文（包括非组件 setup）中调用。
 */
export async function triggerPlayFromUrl(): Promise<void> {
  // 用 ref 存储输入值，配合 TDesign Input 组件双向绑定
  const inputValue = ref('')

  // 1. 弹出输入框，使用 DialogPlugin + h() 渲染 TDesign Input 组件
  const result = await new Promise<string | null>((resolve) => {
    const dialog = DialogPlugin({
      header: '从 URL 放映',
      // 使用 h() 渲染带有 Input 组件的 body
      body: () =>
        h('div', { style: 'display: flex; flex-direction: column; gap: 10px;' }, [
          h(
            'p',
            { style: 'margin: 0 0 6px; color: var(--td-text-color-secondary); font-size: 13px;' },
            '请输入 .ea2 或 .json 考试配置文件的完整 URL'
          ),
          h(Input, {
            value: inputValue.value,
            placeholder: 'https://example.com/exam.ea2',
            autofocus: true,
            clearable: true,
            onInput: (val: string) => {
              inputValue.value = val
            },
            onChange: (val: string) => {
              inputValue.value = val
            }
          })
        ]),
      confirmBtn: '开始下载',
      cancelBtn: '取消',
      onConfirm: () => {
        dialog.hide()
        resolve(inputValue.value.trim())
      },
      onClose: () => {
        dialog.hide()
        resolve(null)
      },
      onCancel: () => {
        dialog.hide()
        resolve(null)
      }
    })
  })

  // 用户取消或未输入
  if (result === null || result === '') return

  // 2. 基础格式校验
  if (!URL_REGEX.test(result)) {
    MessagePlugin.warning({
      content: 'URL 格式无效，请输入以 http:// 或 https:// 开头的完整地址',
      duration: 4000,
      closeBtn: true
    })
    return
  }

  // 3. 显示全屏 loading 遮罩
  const loading = LoadingPlugin({
    text: '正在下载配置文件...',
    fullscreen: true,
    loading: true
  })

  try {
    // 4. 调用主进程 IPC handler
    const apiResult = await window.api.exam.playFromUrl(result)

    if (apiResult?.success) {
      MessagePlugin.success({
        content: '配置文件下载成功，放映器已启动！',
        duration: 3000,
        closeBtn: true
      })
    } else {
      const errMsg = apiResult?.error ?? '未知错误'
      MessagePlugin.error({
        content: `从 URL 加载失败：${errMsg}`,
        duration: 6000,
        closeBtn: true
      })
    }
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err)
    MessagePlugin.error({
      content: `从 URL 加载时发生意外错误：${message}`,
      duration: 6000,
      closeBtn: true
    })
  } finally {
    // 5. 关闭 loading 遮罩
    loading.hide()
  }
}

/**
 * Vue Composable 封装（可在组件 setup 中使用）。
 */
export function usePlayFromUrl() {
  return {
    triggerPlayFromUrl
  }
}
