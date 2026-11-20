/**
 * 托管轮落盘发送者名 + 对外盖章名（**身份名的唯一取值点**）
 *
 * 从 extension.ts 迁出：托管派发（`chatPanel.dispatchHostedInput`）与装配侧要落同一个名字
 * ——chatPanel 不得反向 import extension.ts（循环依赖），故常量下沉到 host 层无依赖文件。
 *
 * 2026-11-20 用户拍板：助手对外名 = 「memora宝」，派发气泡据此盖「memora宝 发送」。
 * 本常量同时是**唯一身份真源**：落盘 `RoundMessage.name`、实时回声的发送者名、
 * 装配侧 `orchestratorSenderName` / `agentName` 都从这里取；UI 不得再写第二份名字字面量。
 * 派发场景若解析出「来源助手会话名」，渲染优先显示会话名（那是「谁派的」，不是「谁」）。
 * `send_to_session` 的 handler 不得再写字面量（否则就是第二份真源）。
 */
export const HOSTED_SENDER_NAME = 'memora宝';
