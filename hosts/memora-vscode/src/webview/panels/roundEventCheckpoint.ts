/**
 * step 原子检查点的事件落盘（从 chatPanel 外置：单点判断「哪些正文可写」+ 面板行数闸门）
 *
 * 历史只读契约：已收场轮（complete / interrupted）只允许**会话末尾轮**被续跑改写；
 * 且整轮回写必须基于**盘上现值**（`getByIdFresh`），不得用本进程旧缓存快照当正文来源——
 * 否则等于把旧正文写回盘。存储层 `save()` 是唯一写入闸，本模块只负责取对正文来源。
 */
import { isRoundSettled, type IRoundStore, type ProcessEvent } from '@zooique/memora';
import { mergeProcessEvents } from '../helpers/processEventMerge.js';
import { foldThoughtEvents } from '../../extension/host/thoughtFold.js';
import { hasFreshRoundRead } from '../../extension/host/workspaceRoundStore.js';

/**
 * 把当前轮已累积过程事件并入轮并落盘（幂等：seq 全局单调 + mergeProcessEvents）
 *
 * @param store 过程事件落盘目标（Round 单文件内聚存储；未注入则静默跳过）
 * @param roundId 当前 turn roundId（内核 chunk 携带）
 * @param events 该轮当前已累积过程事件（含刚 emit 的边界 / metrics）
 */
export function checkpointRoundEvents(
  store: IRoundStore | undefined,
  roundId: string | undefined,
  events: ProcessEvent[],
): void {
  if (!store || !roundId || events.length === 0) return;
  try {
    // 先判是否已收场：缓存快照只用于判型，不能直接当正文来源
    const cached = store.getById(roundId);
    if (!cached) return;
    const settled = isRoundSettled(cached.status);
    // 已收场轮：正文取盘上现值（只并入事件，不回写正文）；缺少新鲜读能力则放弃回写
    const round = settled
      ? hasFreshRoundRead(store)
        ? store.getByIdFresh(roundId)
        : null
      : cached;
    if (!round) {
      if (settled) console.warn('Memora 已收场轮缺少盘上新鲜读能力，跳过事件回写（防正文回写）');
      return;
    }
    // thought 碎片落盘前按 step 聚合（信封开销收敛；UI 流式不受影响，见 foldThoughtEvents）
    round.processEvents = mergeProcessEvents(round.processEvents ?? [], foldThoughtEvents(events));
    store.save(round);
  } catch (err) {
    console.warn('Memora step 原子检查点落盘失败', err);
  }
}
