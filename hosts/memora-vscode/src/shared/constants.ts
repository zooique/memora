/**
 * 插件共享常量 — extension host 与 webview 面板共用的单个真理源
 *
 * 剪枝（2026-08-15 SSOT）：原 `ACTIVE_ROLE_PACK_KEY` 在 extension.ts 与 chatPanel.ts
 * 各定义一份（注释标注"保持同值"），属 stale mirror。下沉到本文件，两侧统一引用，
 * 消除手工同步的漂移风险。
 */

/** 激活角色包的持久化键（vscode globalState）：
 *  用户切换角色包时写入，Agent 装配时读取并优先激活，实现"重启后记住用户选择"。
 *  作用域为用户级（globalState，2026-08-17 由 workspaceState 升为用户级），
 *  符合"角色选择是用户偏好，跨项目共享"的语义（存储层级收敛）。 */
export const ACTIVE_ROLE_PACK_KEY = 'memora.activeRolePack';

/** 角色包组（会议名单）的持久化键（vscode globalState）：
 *  组 = 组长角色包 + 组员名单（{leader, members[]}[]），用户级数据（会议名单容器）。
 *  用户在建组/改组成员时写入，Agent 装配时经 AgentOptions.rolePackTeams 注入内核；
 *  运行时修改经 agent.rolePackManager.setRolePackTeams 热更新。 */
export const ROLE_PACK_TEAMS_KEY = 'memora.rolePackTeams';

/** 写入二次确认开关的持久化键（vscode globalState）：
 *  用户在设置面板开启/关闭时写入，Agent 装配时读取决定是否传 confirmWrites=true，
 *  运行时切换时直接调 agent.security.setConfirmWrites() 热更新。
 *  作用域为用户级（globalState）——安全偏好是用户级设置，跨项目共享。 */
export const CONFIRM_WRITES_KEY = 'memora.confirmWrites';