/**
 * 插件共享常量 — extension host 与 webview 面板共用的单个真理源
 *
 * 剪枝（2026-08-15 SSOT）：原 `ACTIVE_ROLE_PACK_KEY` 在 extension.ts 与 chatPanel.ts
 * 各定义一份（注释标注"保持同值"），属 stale mirror。下沉到本文件，两侧统一引用，
 * 消除手工同步的漂移风险。
 */

/** 激活角色包的持久化键（vscode workspaceState）：
 *  用户切换角色包时写入，Agent 装配时读取并优先激活，实现"重启后记住用户选择"。
 *  作用域为工作区级（workspaceState），符合"角色选择是工作区偏好"的语义。 */
export const ACTIVE_ROLE_PACK_KEY = 'memora.activeRolePack';