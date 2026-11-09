/**
 * 作品投影 — 纯派生层（无 `vscode` 依赖，便于单测直喂）
 *
 * 定位：把「内核清单快照」派生为「设置页要显示的行 / 空态文案」。**只做形状翻译**，
 * 判据一律来自内核（`listManagedWorks()` 已把 `resident` 归一为布尔），本文件不得写
 * `resident === true` / 文件存在性 / 字符上限这类判断（宿主零判据纪律）。
 * 失效徽标同理：只读内核 `Agent.residentSegmentReport` 的报告，不在宿主复算「哪条生效」。
 *
 * 输出形状在 `shared/workProjectionDto.ts`（extension host 与 webview 共用、零依赖）。
 * 🔴 本层**不含任何渲染面字段**：ThemeIcon id、菜单 contextValue 都是 TreeView 专属，
 * 侧边栏树退役后若留在这里，会在 webview 侧变成没人消费的僵尸载荷（判据散点）。
 * 图标由 webview 依 `resident` / `hasFailure` 自行选择，派生层只给语义。
 *
 * 与 QuickPick 的关系：两者是同一份清单的两个视图，**不是两份数据**——都读
 * `listManagedWorks()`，本文件只负责行的文案 / 状态形状。
 */
import type { WorkProjectionRow, WorkProjectionViewState } from '../../shared/workProjectionDto.js';

export type { WorkProjectionRow, WorkProjectionViewState } from '../../shared/workProjectionDto.js';

/** 清单条目最小形状（结构对齐内核 `ManagedWorkEntry`，宿主只读这些字段） */
export interface WorkEntryView {
  /** 作品名 */
  name: string;
  /** 一句话说明 */
  description: string;
  /** 源文件路径（相对项目根） */
  source: string;
  /** 是否项目规则（内核归一结果，宿主不二次判断） */
  resident: boolean;
}

/**
 * 单条规则失效的原因码（与内核 `ResidentSegmentEntryFailure.reason` 同宽）
 *
 * 故意写成闭合联合而不是 `string`：内核新增原因码时，本文件与调用点会**编译期报红**，
 * 强制在这里显式决定「新原因在 UI 上叫什么」——否则新码会静默落进兜底文案，
 * 用户看到「未注入」却不知道是哪一类（与内核「新增码必须显式决定是否模型可见」同一条纪律）。
 */
export type ResidentFailureReason =
  | 'outside-workspace'
  | 'blocked-path'
  | 'not-textual'
  | 'missing'
  | 'read-error'
  | 'too-long'
  | 'total-exceeded'
  | 'resident-not-boolean';

/** 单条规则失效记录（宿主只读三字段：定位 / 分类 / 人读文案） */
export interface ResidentFailureView {
  /** 失效条目的清单相对路径 */
  source: string;
  /** 失效原因码（见 `ResidentFailureReason`） */
  reason: ResidentFailureReason;
  /** 内核给出的人读文案（含实际计量 / 实际写入值，直接进 tooltip） */
  message: string;
}

/**
 * 内核项目规则求值报告（宿主只读面，结构对齐内核 `ResidentSegmentReport`）
 *
 * `null`（报告本身不存在）= **尚未求值**（还没跑过 turn / 整层未启用）——此时不得显示
 * 「零失效」：没求值过与求值过且零失效是两件事，混成一件事就是假绿。
 */
export interface ResidentReportView {
  /** 完整失效集（含内核不进模型段首的 `resident-not-boolean`） */
  failures: readonly ResidentFailureView[];
  /** 因合计超限被按序丢弃的条目（按清单顺序） */
  dropped: readonly ResidentFailureView[];
  /** 本轮清单是否读到（false ⇒ 整段为空，报告不能当作「零失效」用） */
  listReadable: boolean;
}

/** 空态 / 错误态文案（常量集中，避免散落在 provider 与测试里各写一份） */
const MESSAGES = {
  /** 无会话时可归属的 Agent */
  noAgent: '尚未创建任何会话：先打开 Memora 对话面板',
  /** 清单文件格式异常（内核 fail-safe 拒绝改写） */
  malformed: '作品投影清单格式异常（work-projections.json 顶层必须是 JSON 数组），已跳过写入',
  /** 清单为空 */
  empty: '还没有登记作品投影：在资源管理器里右键文件 →「Memora: 登记作品投影」',
  /** 规则报告尚未生成（不等于零失效，也不等于整层关闭——宿主拿不到这两种区分，只能如实说未求值） */
  reportPending: '项目规则尚未求值：发起一轮对话后才会显示本轮注入了哪些规则',
  /** 规则报告是「清单没读到」的产物（本轮整段为空，不能当作零失效） */
  reportUnreadable:
    '项目规则最近一次求值未读到清单：本轮不注入任何规则（检查 work-projections.json 后重试）',
} as const;

/**
 * 失效原因码 → 行内短标签（唯一映射点，UI 文案不散落在调用方）
 *
 * 只描述「为什么没生效」，不承诺「下轮会好」：读盘失败可重试，但单条超限必须拆文件、
 * 非布尔误配必须改清单——统一说成「下轮重试」会让用户白等。
 *
 * @param reason 内核失效原因码
 * @returns 行内短标签
 */
function failureLabel(reason: ResidentFailureReason): string {
  switch (reason) {
    case 'outside-workspace':
    case 'blocked-path':
    case 'not-textual':
    case 'missing':
    case 'read-error':
      return '未注入（读取失败）';
    case 'too-long':
      return '未注入（单条超限）';
    case 'total-exceeded':
      return '未注入（合计超限）';
    case 'resident-not-boolean':
      return '配置有误';
  }
}

/**
 * 派生视图状态
 *
 * 判据优先级：无 Agent > 清单格式异常 > 空清单 > 行。前三种都是「拿不到行」的不同原因，
 * 必须分开显示——合并成一句「暂无内容」会让用户按错方向自救（格式异常要改 JSON，
 * 空清单要登记，无会话要开会话）。
 *
 * @param input.hasAgent 是否取到了当前会话 Agent
 * @param input.listMalformed 内核 `isFileMalformed` 读面（格式异常时 register 会拒绝写入）
 * @param input.entries 内核 `listManagedWorks()` 快照（已归一 `resident`）
 * @param input.residentReport 内核本轮求值报告（`null` = 尚未求值，**不得**当作零失效）
 * @returns 视图状态（行按清单顺序，不重排）
 */
export function deriveWorkProjectionView(input: {
  hasAgent: boolean;
  listMalformed: boolean;
  entries: readonly WorkEntryView[];
  residentReport: ResidentReportView | null;
}): WorkProjectionViewState {
  if (!input.hasAgent) return { kind: 'no-agent', message: MESSAGES.noAgent };
  if (input.listMalformed) return { kind: 'malformed', message: MESSAGES.malformed };
  if (input.entries.length === 0) return { kind: 'empty', message: MESSAGES.empty };

  // 失效索引：完整失效集 ∪ 丢弃集。同一条不会两边都有——能进丢弃集的前提是读盘与单条上限都通过
  const failureBySource = new Map<string, ResidentFailureView>();
  for (const failure of input.residentReport?.failures ?? []) {
    failureBySource.set(failure.source, failure);
  }
  for (const failure of input.residentReport?.dropped ?? []) {
    failureBySource.set(failure.source, failure);
  }

  // 行派生：顺序真源 = 清单数组顺序（与注入段的「靠前者优先」同一份顺序，不另排序）
  const rows: WorkProjectionRow[] = input.entries.map((e) => {
    // 常驻态的唯一来源是内核归一结果；这里只决定「显示成什么」
    const base = e.resident ? '项目规则' : '未设为项目规则';
    const failure = failureBySource.get(e.source);
    const baseTooltip = e.description ? `${e.source}\n${e.description}` : e.source;
    return {
      source: e.source,
      name: e.name,
      // 后缀同时答两问：本意是不是规则 / 本轮有没有生效（后者缺失时保持原样，不写「正常」）
      statusText: failure ? `${base} · ${failureLabel(failure.reason)}` : base,
      // 内核文案带实际计量与写入值，放 tooltip 比塞进单行后缀更可读
      tooltip: failure ? `${baseTooltip}\n\n${failure.message}` : baseTooltip,
      // 语义二元组（不是图标 id）：渲染面自己决定「项目规则 / 普通 / 失效」各画什么
      resident: e.resident,
      hasFailure: failure !== undefined,
    };
  });

  // 报告层面的两种「不可当作零失效」态（不是某一条的问题，行内徽标表达不了）
  let notice: { text: string; level: 'info' | 'warning' } | undefined;
  if (!input.residentReport) {
    // 只有真配了规则才提示「尚未求值」：一条规则都没有时这句话是噪音
    if (input.entries.some((e) => e.resident)) {
      notice = { text: MESSAGES.reportPending, level: 'info' };
    }
  } else if (!input.residentReport.listReadable) {
    notice = { text: MESSAGES.reportUnreadable, level: 'warning' };
  }

  return notice ? { kind: 'rows', rows, notice } : { kind: 'rows', rows };
}
