/**
 * 记忆面板事件映射 — 回调签名单一真理源（AUDIT-H6）
 *
 * 事件名统一 kebab-case（与 DOM data-action 命名风格一致）。
 * 每个事件对应一个回调签名；onXxx() 注册方法 / TypedEventBus 存储 / helper 触发
 * 均从此映射推导类型，禁止在别处手写重复签名。
 *
 * 与 onXxx() 方法名映射关系（实施时逐条对照，勿机械转换）：
 *   onMemorySearch       → 'memory-search'
 *   onMemoryFilter       → 'memory-filter'
 *   onMemoryClick        → 'memory-click'
 *   onMemoryDelete       → 'memory-delete'
 *   onMemoryAdd          → 'memory-add'
 *   onMemoryEdit         → 'memory-edit'
 *   onMemoryDiscuss      → 'memory-discuss'
 *   onMoreMenuAction     → 'more-menu-action'
 *   onSortChange         → 'sort-change'
 *   onTimeRangeChange    → 'time-range-change'
 *   onCleanupRequest     → 'cleanup-request'
 *   onCleanupConfirm     → 'cleanup-confirm'
 *   onLlmGovernance      → 'llm-governance'
 *   onViewSwitch         → 'view-switch'
 *   onGraphContextMenuAction → 'graph-context-menu'
 *   onRelationEdit       → 'relation-edit'
 *   onRelationDelete     → 'relation-delete'
 *   onRelationCreate     → 'relation-create'
 *   onRecycleBinAction   → 'recycle-bin-action'
 *   onRecycleBinBatchAction → 'recycle-bin-batch-action'
 *
 * 类型说明：使用 type 别名而非 interface——interface 缺少隐式字符串索引签名，
 * 不满足 TypedEventBus 的 `Record<string, AnyListener>` 约束（TS2344）；
 * type 别名是封闭类型，TS 为其推断隐式索引签名。
 */
export type MemoryPanelEventMap = {
  /** 搜索记忆（防抖后触发，query 为空表示清除搜索） */
  'memory-search': (query: string) => void;
  /** 来源筛选（空字符串表示全部来源） */
  'memory-filter': (source: string) => void;
  /** 记忆项点击（列表/图谱/详情内关联项/脉络节点共用） */
  'memory-click': (id: string) => void;
  /** 删除当前记忆 */
  'memory-delete': () => void;
  /** 添加记忆（表单校验通过后） */
  'memory-add': (data: { source: string; name: string; content: string }) => void;
  /** 编辑记忆内容（保存按钮 / Ctrl+Enter） */
  'memory-edit': (id: string, content: string) => void;
  /** 讨论记忆（切换到对话面板预填） */
  'memory-discuss': (memoryName: string) => void;
  /** 更多菜单项点击（insights/health/completion-stats/recycle-bin/partner-insights） */
  'more-menu-action': (action: string) => void;
  /** 排序方式变更 */
  'sort-change': () => void;
  /** 时间范围变更 */
  'time-range-change': () => void;
  /** 清理请求（返回待清理 ID 列表；未注册返回 undefined，调用方 ?? [] 兜底） */
  'cleanup-request': (type: 'duplicates' | 'stale' | 'all') => string[];
  /** 清理确认（执行批量删除） */
  'cleanup-confirm': (ids: string[]) => Promise<void>;
  /** LLM 记忆治理（dedup/timeliness/conflicts） */
  'llm-governance': (action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>;
  /** 视图切换（通知 Controller 同步按钮 active 状态） */
  'view-switch': (mode: 'list' | 'timeline' | 'graph') => void;
  /** 图谱上下文菜单操作 */
  'graph-context-menu': (action: string, nodeId: string) => void;
  /** 关系编辑 */
  'relation-edit': (sourceId: string, targetId: string, type: string, weight: number) => void;
  /** 关系删除 */
  'relation-delete': (sourceId: string, targetId: string, type: string) => void;
  /** 关系创建 */
  'relation-create': (sourceId: string, targetId: string, type: string, weight: number) => void;
  /** 回收站单项操作（restore/purge） */
  'recycle-bin-action': (action: 'restore' | 'purge', id: string) => Promise<void>;
  /** 回收站批量操作（restore-all/purge-all） */
  'recycle-bin-batch-action': (action: 'restore-all' | 'purge-all') => Promise<void>;
};
