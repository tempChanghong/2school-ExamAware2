export interface PlayerOpenOptions {
  source?: 'file' | 'url' | 'remote'
  pathOrUrl?: string
}

export interface PlayerLauncher {
  selectLocalAndOpen(): Promise<void>
  openWith(options: PlayerOpenOptions): Promise<void>
}

export function createPlayerLauncher(ipc = window.api.ipc): PlayerLauncher {
  return {
    async selectLocalAndOpen() {
      const p = await ipc.invoke('select-file')
      if (p) await this.openWith({ source: 'file', pathOrUrl: p })
    },
    async openWith(options: PlayerOpenOptions) {
      // 打开本地文件
      if (options.source === 'file' && options.pathOrUrl) {
        ipc.send('open-player-window', options.pathOrUrl)
        return
      }
      // 从 URL 下载并打开（通过主进程 IPC handler 完成下载、保存、启动）
      if (options.source === 'url' && options.pathOrUrl) {
        const result = await (window.api as any).exam.playFromUrl(options.pathOrUrl)
        if (!result?.success) {
          throw new Error(result?.error ?? '从 URL 打开放映器失败')
        }
        return
      }
      throw new Error('不支持的打开方式或缺少路径/URL')
    }
  }
}
