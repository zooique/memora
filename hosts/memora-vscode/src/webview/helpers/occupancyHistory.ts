/**
 * 会话历史 → 「占用估算输入」的映射（无 DOM 副作用的纯转换）
 *
 * 为什么单独成文件：`chatPanel.ts` 贴着 eslint `max-lines` 的一道 **只降不升**基线
 * （2026-10-28 本次变更把该档从 4515 撞到 4535，当场 lint 红），在那里加代码前必须
 * 先算行数账；而本转换又是纯函数、无 DOM 副作用，天然属于 helper 层而非面板类
 * （与项目「放置类外置 helper」的做法一致）。
 */
import { isRoundSettled, type ImageRef } from '@zooique/memora';
import type { RoundView } from '../../shared/protocol.js';

/**
 * 占用估算输入消息形态
 *
 * `attachments` 是可选字段：**没有图片的会话不应该多出来一个空数组**，
 * 保持与「无附件历史」同形状（也是占用环在没有图片时零行为变化的保证）。
 */
export interface OccupancyMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: readonly ImageRef[];
}

/**
 * round-based 轮次 → 占用估算输入序列
 *
 * ⚠️ **必须透传 `userMessage.attachments`**（方案 §7 P0-11 / §9，亦称真缺口①）：
 * 这些 attachments 已随内核 `MessageHistory.appendUser` 的白名单落盘，是本函数的输入事实；
 * 此处一旦漏传，占用环就只按文字计、图片整块漏算，UI 显示「还剩 8k」而实际已溢出。
 * 图片 token 的折算由内核单点 `estimateTokensMessages` 负责（按尺寸 patches 公式），
 * 本函数**只负责把带 attachments 的历史喂给它**，绝不在此自行重算第二次。
 *
 * assistant 侧的判据与 `loadRoundBasedHistory` 对齐：**仅 complete 轮**取正文——
 * 中断轮的正文与平铺 narrate 同源，计入会重复计一次。
 *
 * @param rounds 已按时间顺序排列的历史轮次
 * @returns 占用估算输入序列（含 user/assistant 两向）
 */
export function toOccupancyMessages(rounds: readonly RoundView[]): OccupancyMessage[] {
  const msgs: OccupancyMessage[] = [];
  for (const r of rounds) {
    if (r.userMessage?.content) {
      msgs.push({
        role: 'user',
        content: r.userMessage.content,
        ...(r.userMessage.attachments ? { attachments: r.userMessage.attachments } : {}),
      });
    }
    // 「轮是否已收场」这件事的判据在内核单点（`isRoundSettled`），**不在宿主重抄一遍**
    // —— 曾在此直接写 `status === 'complete'`，被内核 `roundStore.test.ts` 的
    // 「判据单源守卫」当场抓到（全网禁止自写该比较）。宿主持的唯一职责是**调用**它。
    if (isRoundSettled(r.status) && r.assistantMessage?.content) {
      msgs.push({ role: 'assistant', content: r.assistantMessage.content });
    }
  }
  return msgs;
}
