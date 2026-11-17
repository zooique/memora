/**
 * Hand back 消费者骨架（P2 · 2026-11-17）
 *
 * Worker 产出 Hand back 消息 → 宿主解析 → 注入助手 loop 的通道。
 * 和 HostedSessionNotifier 同定位：都走 enqueueCommandResult，一个是 Worker 终态通知，
 * 一个是 Worker 超界 Hand back。
 *
 * 【骨架范围】
 *   ✅ 已钉：HandBackMessage 解析 / 格式化（handBackMessage.ts 纯函数）
 *   ✅ 已钉：消费者入口 + 依赖接口（仿照 HostedSessionNotifierDeps）
 *   ✅ 已钉：转发逻辑（找助手 loop → enqueueCommandResult）
 *   ✅ 已钉：幂等守卫（同 session 同 reason 只投一次）
 *   ⏳ 待真实案例：Worker → 宿主的物理触发通道（谁、什么时候调 handleHandBack）
 *
 * 三原则：
 *   SSOT  — 解析/格式化同 handBackMessage.ts，消费者只做路由；enqueueCommandResult 是既有通道
 *   自然生长 — 不新建通道、不新建实体；Worker 侧触发条件等真实案例
 *   不带伤 — 自助模式零引用；消费者仅托管 Worker 产出时触发
 */
import type { Agent } from '@zooique/memora';
import {
  formatHandBackMessage,
  isHandBackMessage,
  parseHandBackMessage,
} from './handBackMessage.js';

/** 消费者依赖（与 HostedSessionNoticeDeps 对齐，最小集） */
export interface HandBackConsumerDeps {
  /** Worker 会话 → 创建它的助手会话（登记来源 = 托管 Worker 创建流程） */
  lookupCreator: (workerSessionId: string) => string | undefined;
  /** 同步取助手 loop（取不到就如实不投） */
  getAgent: (sessionId: string) => Agent | undefined;
  /** 助手当前是否仍活跃（被收回 / 关窗后不再打扰） */
  isManaged: (sessionId: string) => boolean;
}

/**
 * Hand back 消费者实例（每个面板一个实例，进程内状态）
 *
 * 只做"Worker Hand back → 助手上下文"路由，不做助手侧决策——
 * 那是助手收到 Hand back 消息后自己做的事（等真实案例钉）。
 */
export class HandBackConsumer {
  /**
   * 已投递过的 `${workerSid}:${reason}` 去重键
   * 同一 Worker 同一超界原因重复信号只投一次（幂等）
   */
  private readonly delivered = new Set<string>();

  constructor(private readonly deps: HandBackConsumerDeps) {}

  /**
   * 入口：宿主在某处收到 Worker 产出的 Hand back 消息时调
   *
   * 【骨架】Worker → 宿主的物理触发通道待真实案例钉：
   *   - 可能通道 A：Worker 执行 run_command 输出 [HAND_BACK] → 宿主命令结果回调识别
   *   - 可能通道 B：Worker loop 加 Hand back hook → 宿主装配 Worker loop 时注册
   *   - 可能通道 C：Worker 发 ask_user → 宿主识别内容里的 [HAND_BACK] 前缀
   *   等 ≥3 个真实案例后钉死一条，其余通道自然退役。
   *
   * @param workerSessionId 产出 Hand back 的 Worker 会话
   * @param rawText Worker 产出的原始文本（必须以 [HAND_BACK] 开头，否则跳过）
   * @returns true = 已投进助手事件队列；false = 本轮未投（不合法 / 无创建者 / 助手已关）
   */
  handleHandBack(workerSessionId: string, rawText: string): boolean {
    // 1. 快速分流：不是 Hand back 消息直接跳
    if (!isHandBackMessage(rawText)) return false;

    // 2. 解析：结构化对象，失败（reason 缺失）返回 null 即不投
    const msg = parseHandBackMessage(rawText);
    if (!msg) return false;

    // 3. 幂等守卫：同 Worker 同 reason 只投一次
    const dedupKey = `${workerSessionId}:${msg.reason}`;
    if (this.delivered.has(dedupKey)) return true; // 已投过不算失败
    this.delivered.add(dedupKey);

    // 4. 路由：找助手 loop
    const creatorSessionId = this.deps.lookupCreator(workerSessionId);
    if (!creatorSessionId) return false; // Worker 没有登记创建者（不应发生，但如实降级）
    if (!this.deps.isManaged(creatorSessionId)) return false; // 助手已被收回 / 关窗

    const loop = this.deps.getAgent(creatorSessionId)?.agentLoop;
    if (!loop) return false; // 助手 loop 实例未就绪

    // 5. 格式化 + 注入助手上下文
    //    注意：用 formatHandBackMessage 再走一遍格式化，不是直接投 rawText——
    //    理由：parse → format 这一步是"规范化"，确保不管 Worker 原始格式多歪，
    //    助手收到的都是标准格式（字段顺序、trim、payload JSON 合法）
    const normalized = formatHandBackMessage(msg);
    loop.enqueueCommandResult(normalized);
    return true;
  }
}
