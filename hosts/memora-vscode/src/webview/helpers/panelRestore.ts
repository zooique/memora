/**
 * WebviewPanel 恢复拦截辅助（VS Code 重启时自动恢复的空壳处理）
 *
 * 背景（真机实测 2026-11-17）：createWebviewPanel 创建的独立编辑器 tab 会被 VS Code
 * 在重启时自动恢复，但恢复的只是一个空壳占位（webview 上下文已丢、html 未设），
 * 用户看到的是空白 tab 要手动关。
 *
 * 修法：给需要"不恢复"的面板注册 WebviewPanelSerializer，deserialize 时直接
 * dispose 传入的 panel——VS Code 收到空面板就丢弃，不留占位。
 *
 * 为什么不用 vscode.window.allWebviewPanels？
 * 那个 API 是 1.93 才加的公开只读数组，宿主锁定 ~1.90.0 不可用。
 * registerWebviewPanelSerializer 1.90 就有，是官方给自定义恢复逻辑的通道。
 *
 * 为什么不在 activate 开头自己 dispose？
 * 激活时 VS Code 可能还没完成 WebviewPanel 的恢复（恢复是异步的），
 * activate 里的清理会 race 失败。deserializer 在 VS Code 恢复面板的那一刻被调，
 * 时机准确无 race。
 */
import * as vscode from 'vscode';

/**
 * 注册一个「恢复即销毁」的 serializer
 *
 * VS Code 试图恢复 viewType 面板时，deserialize 立刻 dispose 它——
 * 相当于告诉 VS Code「这个面板不要恢复」。
 *
 * @param viewType 面板类型（与 createWebviewPanel 首参一致）
 * @returns Disposable（activate 里 push  subscriptions）
 */
export function registerDisposeOnRestore(viewType: string): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(viewType, {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
      // VS Code 刚把这个面板恢复到编辑器区——立刻 dispose，不留空壳
      panel.dispose();
    },
  });
}
