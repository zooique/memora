/**
 * VscodeTracer — VS Code 宿主侧的可观测性实现（P2，§5.2.1 可追溯性边界）
 *
 * 职责：
 *   - 实现内核 ITracer 接口，采集内核埋点产出的 span（llm.call / recall / tool.execute 等）
 *   - 有界采集：内存环形缓冲（上限 200 条），FIFO 截断，不落盘（避免存储膨胀，对齐「有界、可选」边界）
 *   - 提取「模型看到了什么」指纹：systemPromptHash / attachedMemoryCount / attachedMemoryFingerprint
 *     （只记 hash 不记内容——可追溯性边界声明：指纹属可观测性，不入 sessionStore）
 *
 * 设计（薄壳 + 装配）：
 *   - 内核只负责埋点（TRACE_SPANS），本类只做采集 + 提取，不重复埋点
 *   - 模块级单例（vscodeTracer）：插件为单 Agent 单窗口模型，与 agentPromise 单例同构，
 *     装配（assemble）与面板（chatPanel）共享同一实例，避免跨层传参
 */
import type { ISpan, ITracer } from '@zooique/memora';
import { TRACE_SPANS } from '@zooique/memora';

/** span 属性值类型（对齐内核 ITracer 的 span 属性类型） */
type SpanAttributeValue = string | number | boolean;

/** 采集到的 span 记录（宿主侧最小形态：名称 + 属性 + 时间戳） */
interface SpanRecord {
  /** span 名称（对齐 TRACE_SPANS，如 'llm.call'） */
  name: string;
  /** span 属性（键值对，指纹/计数/耗时等） */
  attributes: Record<string, SpanAttributeValue>;
  /** 结束时间戳（毫秒） */
  at: number;
}

/** 环形缓冲上限（有界采集：防长期运行内存膨胀） */
const SPAN_BUFFER_MAX = 200;

/** 宿主侧 span 实现：收集属性到 record，结束时间戳 */
class VscodeSpan implements ISpan {
  private readonly attrs: Record<string, SpanAttributeValue> = {};
  private ended = false;

  constructor(
    private readonly onEnd: (name: string, attrs: Record<string, SpanAttributeValue>, at: number) => void,
    private readonly name: string,
    initialAttrs?: Record<string, SpanAttributeValue>,
  ) {
    if (initialAttrs) Object.assign(this.attrs, initialAttrs);
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    this.attrs[key] = value;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd(this.name, this.attrs, Date.now());
  }

  recordException(_error: Error): void {
    // 宿主采集层暂不记录异常详情（保持有界、轻量）；如需异常面可扩展属性
  }
}

/** VscodeTracer — 宿主侧 ITracer 实现（有界内存采集） */
export class VscodeTracer implements ITracer {
  /** 已结束的 span 记录（环形缓冲，FIFO） */
  private readonly spans: SpanRecord[] = [];

  startSpan(name: string, attributes?: Record<string, SpanAttributeValue>): ISpan {
    return new VscodeSpan((n, attrs, at) => this.record(n, attrs, at), name, attributes);
  }

  /** 记录一条已结束的 span（FIFO 截断，有界） */
  private record(name: string, attributes: Record<string, SpanAttributeValue>, at: number): void {
    this.spans.push({ name, attributes, at });
    if (this.spans.length > SPAN_BUFFER_MAX) this.spans.shift();
  }

  /**
   * 提取最近一轮的「模型看到了什么」指纹（§5.2.1 可追溯性边界）
   *
   * 从最近已结束的 llm.call span 取 systemPromptHash、recall span 取附着记忆指纹。
   * 只返回 hash 与计数，不返回内容——与内核边界声明一致（指纹属可观测性，不入存储）。
   *
   * @returns 指纹摘要（未采集到对应 span 时字段缺省）
   */
  getLatestFingerprints(): { systemPromptHash?: string; attachedMemoryCount?: number; attachedMemoryFingerprint?: string } {
    let systemPromptHash: string | undefined;
    let attachedMemoryCount: number | undefined;
    let attachedMemoryFingerprint: string | undefined;
    // 倒序找最近的对应 span（llm.call 可能多次，取最后一条）
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const s = this.spans[i];
      if (s.name === TRACE_SPANS.LLM_CALL && !systemPromptHash) {
        const v = s.attributes.systemPromptHash;
        if (typeof v === 'string') systemPromptHash = v;
      } else if (s.name === TRACE_SPANS.RECALL) {
        if (typeof s.attributes.attachedMemoryCount === 'number') attachedMemoryCount = s.attributes.attachedMemoryCount;
        const fp = s.attributes.attachedMemoryFingerprint;
        if (typeof fp === 'string') attachedMemoryFingerprint = fp;
      }
    }
    return { systemPromptHash, attachedMemoryCount, attachedMemoryFingerprint };
  }
}

/** VscodeTracer 单例（装配与面板共享，见文件头设计说明） */
export const vscodeTracer = new VscodeTracer();
