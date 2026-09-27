/**
 * VscodeTracer — VS Code 宿主侧的可观测性实现（P2，§5.2.1 可追溯性边界）
 *
 * 职责：
 *   - 实现内核 ITracer 接口，采集内核埋点产出的 span（llm.call / tool.execute 等）
 *   - 有界采集：内存环形缓冲（上限 200 条），FIFO 截断，不落盘（避免存储膨胀，对齐「有界、可选」边界）
 *   - 提取「模型看到了什么」指纹：systemPromptHash
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
    private readonly onEnd: (
      name: string,
      attrs: Record<string, SpanAttributeValue>,
      at: number,
    ) => void,
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
   * 提取最近最近几轮的 span 作为「透明面板」的操作流（可观测补齐）
   *
   * 把本类已采集的 span 缓冲暴露出来（不止于指纹提取），供透明面板渲染操作序列
   * （LLM → 工具 → 响应…）。只回传 span 名 + 关键属性加工成的展现标签，
   * 不传原始内容（延续「指纹可观测、不入存储」的可追溯性边界）。
   *
   * @param limit 返回条数上限（默认 20，新→旧排序；超界由调用方控制）
   * @returns 最近已结束 span 的展现序列（新→旧）
   */
  getRecentTraces(limit = 20): { label: string }[] {
    // 倒序遍历取最近 limit 条，映射为中文展现标签
    return this.spans
      .slice(-limit)
      .reverse()
      .map((s) => ({ label: VscodeTracer.labelFor(s) }));
  }

  /**
   * 将一条 span 映射为透明面板的展现标签（中文，工具 span 附带工具名）
   *
   * 命中 TRACE_SPANS 已知 span 名时给出语义化中文标签；未知名回退原始 span 名。
   *
   * @param record 已采集的 span 记录
   * @returns 展现标签
   */
  private static labelFor(record: SpanRecord): string {
    switch (record.name) {
      case TRACE_SPANS.LLM_CALL:
        return 'LLM 调用';
      case TRACE_SPANS.TOOL_EXEC: {
        // 工具 span 附带具体工具名（toolRunner 埋点），展现「工具·<名>」更透明
        const tool = record.attributes.tool;
        return typeof tool === 'string' ? `工具·${tool}` : '工具';
      }
      case TRACE_SPANS.RESPONSE:
        return '响应生成';
      case TRACE_SPANS.CONTEXT_SUMMARY:
        return '压缩摘要';
      case TRACE_SPANS.POST_PROCESS:
        return '会话归档';
      case TRACE_SPANS.DIFFICULTY:
        return '难度分级';
      case TRACE_SPANS.REPORT:
        return '收尾汇报';
      default:
        return record.name;
    }
  }

  /**
   * 提取最近一轮的「模型看到了什么」指纹（§5.2.1 可追溯性边界）
   *
   * 从最近已结束的 llm.call span 取 systemPromptHash。
   * 只返回 hash，不返回内容——与内核边界声明一致（指纹属可观测性，不入存储）。
   * 注：原 attachedMemoryCount / attachedMemoryFingerprint 读取分支已随记忆附着
   * 可观测性全链退役删除。
   *
   * @returns 指纹摘要（未采集到对应 span 时字段缺省）
   */
  getLatestFingerprints(): { systemPromptHash?: string } {
    let systemPromptHash: string | undefined;
    // 倒序找最近的 llm.call span（可能多次，取最后一条）
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const s = this.spans[i];
      if (s.name === TRACE_SPANS.LLM_CALL) {
        const v = s.attributes.systemPromptHash;
        if (typeof v === 'string') systemPromptHash = v;
        break;
      }
    }
    return { systemPromptHash };
  }
}

/** VscodeTracer 单例（装配与面板共享，见文件头设计说明） */
export const vscodeTracer = new VscodeTracer();
