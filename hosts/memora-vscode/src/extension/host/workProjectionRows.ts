/**
 * 作品投影树 — 纯派生层（无 `vscode` 依赖，便于单测直喂）
 *
 * 定位：把「内核清单快照」派生为「树上要显示的行 / 空态文案」。**只做形状翻译**，
 * 判据一律来自内核（`listManagedWorks()` 已把 `resident` 归一为布尔），本文件不得写
 * `resident === true` / 文件存在性 / 字符上限这类判断（宿主零判据纪律）。
 *
 * 与 QuickPick 的关系：两者是同一份清单的两个视图，**不是两份数据**——都读
 * `listManagedWorks()`，本文件只负责树行的 label/description/icon/contextValue 形态。
 */

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

/** 树上的一行（纯数据；provider 负责转成 `vscode.TreeItem`） */
export interface WorkProjectionRow {
  /** 清单源路径（右键动作原样回传内核） */
  source: string;
  /** 行标题（作品名） */
  name: string;
  /** 行右侧状态后缀（项目规则 / 未设为项目规则） */
  statusText: string;
  /** 行 tooltip（含源路径与说明，便于不打开文件也能确认是哪一份） */
  tooltip: string;
  /** 行图标 id（VS Code ThemeIcon 名） */
  icon: string;
  /** 树项 contextValue（右键菜单 `when` 判据） */
  contextValue: string;
}

/** 视图整体状态（行 / 空态 / 错误态；空态文案也由本层给出，provider 不另写一套） */
export type WorkProjectionViewState =
  | { kind: 'no-agent'; message: string }
  | { kind: 'malformed'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'rows'; rows: WorkProjectionRow[] };

/** 行 contextValue（右键菜单 `viewItem` 判据；与 `contributes.menus` 的 when 同源） */
export const WORK_PROJECTION_ITEM_CONTEXT = 'memoraWorkProjectionEntry';

/** 空态 / 错误态文案（常量集中，避免散落在 provider 与测试里各写一份） */
const MESSAGES = {
  /** 无会话时可归属的 Agent */
  noAgent: '尚未创建任何会话：先打开 Memora 对话面板',
  /** 清单文件格式异常（内核 fail-safe 拒绝改写） */
  malformed: '作品投影清单格式异常（work-projections.json 顶层必须是 JSON 数组），已跳过写入',
  /** 清单为空 */
  empty: '还没有登记作品投影：在资源管理器里右键文件 →「Memora: 登记作品投影」',
} as const;

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
 * @returns 视图状态（行按清单顺序，不重排）
 */
export function deriveWorkProjectionView(input: {
  hasAgent: boolean;
  listMalformed: boolean;
  entries: readonly WorkEntryView[];
}): WorkProjectionViewState {
  if (!input.hasAgent) return { kind: 'no-agent', message: MESSAGES.noAgent };
  if (input.listMalformed) return { kind: 'malformed', message: MESSAGES.malformed };
  if (input.entries.length === 0) return { kind: 'empty', message: MESSAGES.empty };

  // 行派生：顺序真源 = 清单数组顺序（与注入段的「靠前者优先」同一份顺序，不另排序）
  const rows: WorkProjectionRow[] = input.entries.map((e) => {
    // 常驻态的唯一来源是内核归一结果；这里只决定「显示成什么」
    const statusText = e.resident ? '项目规则' : '未设为项目规则';
    return {
      source: e.source,
      name: e.name,
      statusText,
      tooltip: e.description ? `${e.source}\n${e.description}` : e.source,
      // 图标只表达「是不是项目规则」，不表达「有没有失效」（失效徽标归 H2 批）
      icon: e.resident ? 'shield' : 'file',
      contextValue: WORK_PROJECTION_ITEM_CONTEXT,
    };
  });

  return { kind: 'rows', rows };
}
