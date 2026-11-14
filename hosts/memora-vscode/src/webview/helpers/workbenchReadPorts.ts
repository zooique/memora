/**
 * 工作台只读端口（从聊天面板的私有表上开的一扇只读窗）
 *
 * 为什么单独成文件：`chatPanel.ts` 已贴有效行上限，新增只读口只能以「一个字段 +
 * 一个工厂」的形态接进去；把判据与结构放在这里，面板侧只剩一次构造，行数可控。
 *
 * 硬约束：
 *   - **只读**：全部经 `peek` / `get` 读既有表，不建记录、不投消息、不改布局；
 *   - **不新增状态源**：这里没有缓存、没有计时器、没有第二份状态；
 *   - 创建者账本仅本进程有效（重启后为空），如实反映在清单为空上。
 */

/** 工厂的输入面：每个表都以闭包延迟取（避免字段初始化顺序问题） */
export interface WorkbenchReadPortSources {
  /** 运行态表（`peek` 不建记录） */
  runtime: () => { peek(id: string): { streaming: boolean } | undefined };
  /** 提问协调器表（按会话） */
  asks: () => { get(id: string): { pendingQuestions(): readonly unknown[] } | undefined };
  /** 确认协调器（待确认数） */
  confirm: () => { pendingCount(id: string): number };
  /** 已装配实例表（实例可读 `sessionManager.status`；未装配时为 null） */
  agents: () => { get(id: string): { sessionManager?: { status: string } | null } | undefined };
  /** 中断通知器（创建者账本） */
  notifier: () => { childrenOf(creatorSessionId: string): string[] };
}

/** 工作台可用的只读端口（面板把这一份直接注入快照投影） */
export interface WorkbenchReadPorts {
  /** 是否正在流式生成 */
  isStreaming: (sessionId: string) => boolean;
  /** 是否在等用户（待答 / 待确认；**不含**暂停——角标口径不含暂停） */
  isWaiting: (sessionId: string) => boolean;
  /** 工作台用的「在跑 / 等你」（等你额外含软暂停） */
  peekActivity: (sessionId: string) => { running: boolean; waiting: boolean };
  /** 某托管会话开出去的子会话（创建者账本） */
  childrenOf: (creatorSessionId: string) => string[];
}

/**
 * 构造只读端口
 *
 * @param sources 五个既有表的延迟读取闭包
 * @returns 只读端口（全部为纯读，不产生副作用）
 */
export function createWorkbenchReadPorts(sources: WorkbenchReadPortSources): WorkbenchReadPorts {
  // 在跑：运行态表的流式标志（唯一的运行态真源）
  const isStreaming = (sessionId: string): boolean =>
    sources.runtime().peek(sessionId)?.streaming === true;
  // 等你（角标口径）：有未答提问或有待确认；暂停不在此列（暂停不发角标，历史行为）
  const isWaiting = (sessionId: string): boolean =>
    (sources.asks().get(sessionId)?.pendingQuestions().length ?? 0) > 0 ||
    sources.confirm().pendingCount(sessionId) > 0;
  // 等你（工作台口径）：角标口径 + 该会话实例已软暂停（等你按继续）
  const paused = (sessionId: string): boolean =>
    sources.agents().get(sessionId)?.sessionManager?.status === 'paused';
  return {
    isStreaming,
    isWaiting,
    peekActivity: (sessionId) => ({
      running: isStreaming(sessionId),
      waiting: isWaiting(sessionId) || paused(sessionId),
    }),
    childrenOf: (creatorSessionId) => sources.notifier().childrenOf(creatorSessionId),
  };
}
