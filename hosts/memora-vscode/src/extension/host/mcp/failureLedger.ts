/**
 * MCP 失败账本 — 「这台起不来」的唯一记账处
 *
 * 为什么单独成文件：`runtime.ts` 贴着 eslint `max-lines` 1000 的硬闸门（2026-10-24 加
 * 命令预检时被顶到 1030），而失败记账是一个**独立概念**——它不关心连接怎么建、工具怎么注册，
 * 只回答「最近一次尝试为什么失败」。拆出来之后 runtime 只负责编排，账本只负责留痕。
 *
 * 为什么是模块级单例而不用类：运行态（`running`）是模块级可变引用，失败记录必须与它同
 * 生命周期——`stopMcpServers` 时清空、`startOneServer` 成功时摘除、失败时写入。
 * 包一层实例只会多一个「谁持有它」的问题（和 running 一样，MCP 运行时进程内只有一份）。
 *
 * 失败记录是**观察面**的真相源（面板 `state=failed` + 错误原文）：只写日志不留痕，
 * 用户在最需要排查的时候看到的是一片"没有服务器"（本页首版的缺陷）。
 */

/**
 * 一条失败记录
 *
 * `at` 只用于排查（日志/将来按时间排序），当前 UI 不展示——保留它是为了让"为什么是这条
 * 而不是上一条"有据可查（覆盖写时旧记录丢失，时间戳是唯一痕迹）。
 */
export interface McpFailure {
  /** 可直接展示给用户的失败原因（已截断） */
  readonly error: string;
  /** 记录时刻（Date.now()） */
  readonly at: number;
}

/** 失败原因文本上限（消息进 webview 单行展示；超长截断并注明，不静默丢） */
const MAX_ERROR_TEXT = 300;

/** server 名 → 最近一次失败（成功启动 / 从配置移除 / 停机时摘除） */
const failed = new Map<string, McpFailure>();

/**
 * 记录一次失败（超长截断）
 *
 * 同名重复失败**覆盖**而不是累积：观察面只需要"当前为什么起不来"，历史由日志承担
 * （累积会让面板永远显示第一次的错误，掩盖后来的真实原因）。
 *
 * @param name server 名
 * @param reason 原始错误（Error / 字符串 / 任何被抛出的东西）
 */
export function noteFailure(name: string, reason: unknown): void {
  const text = String(reason ?? '未知错误');
  failed.set(name, {
    error: text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text,
    at: Date.now(),
  });
}

/**
 * 摘除一台的失败记录（启动成功 / 该 server 已从配置移除时调用）
 *
 * @param name server 名
 */
export function clearFailure(name: string): void {
  failed.delete(name);
}

/**
 * 读一台的失败记录
 *
 * @param name server 名
 * @returns 记录；从未失败过 = undefined
 */
export function failureOf(name: string): McpFailure | undefined {
  return failed.get(name);
}

/**
 * 清空全部记录（停机语义：没有运行时就谈不上"失败"，残留会让面板把已删配置继续画红）
 */
export function clearAllFailures(): void {
  failed.clear();
}
