/**
 * IMG-8 宿主兜底 —— 单轮图片三维聚合限额（张数 / 总字节 / token）
 *
 * 判据单点 = `shared/imageTurnLimits`（webview 发送前预检与宿主兜底**同判据**，禁第二份
 * 公式）；token 换算走内核 `imageTokens` 单点（本模块 node 侧，值导入合法，webview 打包
 * 不经过此处）。为什么必须兜底：webview `sendMessage` 清框后才 post，只做 webview 预检时
 * 竞态漏网即静默超限 ⇒ 宿主拒收必须**可见**（静默丢整条 = 背刺）。
 */
import { imageTokens, type ImageRef } from '@zooique/memora';
import { checkImageTurnLimits } from '../../shared/imageTurnLimits.js';

/**
 * 三维聚合限额裁决（IMG-8 宿主兜底）。
 *
 * @param attachments 本轮随消息发出的真值 `ref` 列表（调用方已保证非空才调）
 * @param limitTokens 激活 Provider 的窗口上限（宿主经 `resolveContextWindow` 解析；
 *   `undefined` = 未配置 ⇒ token 维跳过，与内核 tokenBudget 口径一致）
 * @returns 放行返回 `undefined`；拒收返回用户可见原因（带该维具体数字：已用 / 上限 / 超出）
 */
export function imageTurnRejection(
  attachments: readonly ImageRef[],
  limitTokens: number | undefined,
): string | undefined {
  const verdict = checkImageTurnLimits({
    count: attachments.length,
    totalBytes: attachments.reduce((a, r) => a + r.bytes, 0),
    totalTokens: attachments.reduce((a, r) => a + imageTokens(r), 0),
    limitTokens,
  });
  return verdict.ok ? undefined : verdict.message;
}
