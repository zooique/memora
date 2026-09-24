/**
 * 重复工具调用拦截器实现
 *
 * 策略参数化的宿主扩展点
 *
 * 将"机械重复检测"从 AgentLoop 内部逻辑剥离为独立类，
 * 宿主可通过注入自定义 DuplicateCallInterceptor 实现不同策略：
 *   - 按工具名差异化阈值（search 阈值大，delete 阈值小）
 *   - 按工具结果内容做语义重复判定
 *   - 直接 block（硬拦截）而非 warn（软提醒）
 *
 * 设计哲学：
 *   - 默认实现基于"工具名+参数哈希"的机械检测，零配置开箱即用
 *   - 接口极简：check() 返回 'ok'/'warn'/'block' 三态
 *   - 状态管理在 AgentLoop（避免拦截器实例跨会话状态泄漏）
 */
import type {
  DuplicateCallInterceptor,
  DuplicateCheckContext,
  DuplicateCheckVerdict,
} from '@/agent/types.js';
import { sha256Fingerprint } from '@/utils/hash.js';

/**
 * 默认重复调用拦截器（基于哈希的机械检测）
 *
 * 策略：对比当前轮与上一轮的工具调用哈希，连续 N 次相同触发 warn。
 * N 由构造参数 threshold 控制（默认 3，表示累计 3 次重复后触发）。
 *
 * 哈希算法：
 *   1. 按工具名 + 参数排序（消除顺序影响）
 *   2. 参数 JSON 规范化（解析后再序列化，消除空白/键顺序差异）
 *   3. 拼接为 "name(args)|name(args)" 格式
 *   4. SHA256 哈希
 */
export class DefaultDuplicateCallInterceptor implements DuplicateCallInterceptor {
  readonly name = 'default-hash-interceptor';
  private readonly threshold: number;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  /** 当前阈值（loop 据此 SSOT 取阈值，不硬编码） */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * 检查工具调用是否构成重复死循环
   *
   * @param toolCalls 本轮有效的工具调用列表
   * @param context 上下文信息（含 AgentLoop 已计算的 hash 和 count）
   * @returns 判定结果
   */
  check(
    toolCalls: readonly { id: string; function: { name: string; arguments: string } }[],
    context: DuplicateCheckContext,
  ): DuplicateCheckVerdict {
    // 空工具调用列表 → ok
    if (toolCalls.length === 0) return 'ok';

    // 哈希不匹配 → ok（工具调用已变化）
    if (context.currentHash === '' || context.currentHash !== context.lastHash) {
      return 'ok';
    }

    // 达到阈值 → warn
    if (context.duplicateCount >= this.threshold) {
      return 'warn';
    }

    // 未达阈值 → ok（让 AgentLoop 继续累计）
    return 'ok';
  }

  /**
   * 对工具调用列表生成稳定哈希（供 AgentLoop 和外部使用）
   *
   * 静态方法，方便 AgentLoop 在不持有拦截器实例时也能计算哈希。
   * 序列化规则唯一实现：loop 的调用哈希直接调用本方法，单一实现无镜像。
   *
   * @param toolCalls 工具调用列表
   * @returns SHA256 哈希十六进制字符串；空数组返回空字符串
   */
  static hash(
    toolCalls: readonly { id: string; function: { name: string; arguments: string } }[],
  ): string {
    if (toolCalls.length === 0) return '';
    // 按工具名 + 参数排序，消除顺序影响
    const sorted = [...toolCalls].sort((a, b) => {
      const na = a.function.name;
      const nb = b.function.name;
      if (na !== nb) return na < nb ? -1 : 1;
      return a.function.arguments < b.function.arguments ? -1 : 1;
    });
    const signature = sorted
      .map((tc) => {
        // 参数 JSON 规范化：解析后再序列化，消除空白/键顺序差异
        let normalizedArgs = tc.function.arguments;
        try {
          normalizedArgs = JSON.stringify(JSON.parse(tc.function.arguments));
        } catch {
          // 非 JSON 字符串（如纯文本参数），保持原样
        }
        return `${tc.function.name}(${normalizedArgs})`;
      })
      .join('|');
    return sha256Fingerprint(signature);
  }
}