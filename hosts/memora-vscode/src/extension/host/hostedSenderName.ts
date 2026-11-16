/**
 * 托管轮的落盘发送者名（`RoundMessage.name` 单一真源）
 *
 * 从 extension.ts 迁出（HOSTED-CONFIRM-AUTH-1）：授权流叫醒代理（confirmAuthFlow 的
 * `wakeAgent` → `chatPanel.dispatchHostedInput`）也要落同一个名字——chatPanel 不得反向
 * import extension.ts（循环依赖），故常量下沉到 host 层无依赖文件，装配与授权流共用。
 *
 * 当前没有「助手名」用户配置；先集中在此常量，接入配置后只改这一处。
 * `send_to_session` 的 handler 与授权叫醒都不得再写字面量（否则就是第二份真源）。
 */
export const HOSTED_SENDER_NAME = 'Memora';
