/**
 * workProjectionDto — 作品投影的跨进程数据形状（extension host ↔ webview 共用，零依赖）
 *
 * **为什么独立成文件**：`protocol.ts` 的计数守卫按 `type: '...'` 字面量统计消息通道，
 * 而本 DTO 的判别字段叫 `kind`（不叫 `type`）——放进 protocol.ts 会被那条正则误计成
 * 「新通道」，凭空吃掉治理余量。物理隔离后，守卫只数与通信有关的类型，DTO 形状变化
 * 不再干扰通道计数。
 *
 * **为什么不从 `extension/host/workProjectionRows.ts` 导入**：host 侧模块可 import vscode
 * 与内核 Agent；webview 脚本一旦值导入它，就会把整个扩展宿主依赖树拖进 webview bundle。
 * 本文件只含类型、零运行时值，两侧一律 `import type`。
 *
 * 判据纪律：`resident` / `description` 等语义字段直接取内核已归一的结果；`hasFailure` 由宿主
 * 依据内核报告（`failures` ∪ `dropped`）派生；`statusText` 由宿主用 l10n 文案拼 `failureLabel`，
 * `tooltip` 则是源路径 + 内核 `failure.message`（不经 l10n）。
 * webview 不得据此复算
 * 「是不是项目规则 / 有没有失效」——那两个判断的唯一真源是内核 `listManagedWorks()`
 * 与 `Agent.residentSegmentReport`，派生在 `host/workProjectionRows.ts` 单点完成。
 */

/** 清单里的一行（纯数据；渲染成什么由 webview 侧决定） */
export interface WorkProjectionRow {
  /** 清单源路径（动作原样回传内核；单击打开时也是唯一的寻址凭据） */
  source: string;
  /** 行标题（作品名） */
  name: string;
  /** 一句话说明（内核清单原文；卡片内直接显示，不再只塞 tooltip） */
  description: string;
  /** 行右侧状态后缀（项目规则 / 未设为项目规则；本轮有失效时追加分类标签） */
  statusText: string;
  /** 行 tooltip（源路径；失效时附内核原文案。说明已在卡片内显示，不在此重复） */
  tooltip: string;
  /** 内核归一后的项目规则态（webview 只据此选图标，不二次判断） */
  resident: boolean;
  /** 本轮求值是否命中失效（含合计超限被丢弃；webview 只据此选图标） */
  hasFailure: boolean;
}

/**
 * 视图整体状态（行 / 空态 / 错误态）
 *
 * `no-agent` / `malformed` / `empty` 三种是「拿不到行」的不同原因，必须分开显示：
 * 合并成一句「暂无内容」会让用户按错方向自救。
 */
export type WorkProjectionViewState =
  | { kind: 'no-agent'; message: string }
  | { kind: 'malformed'; message: string }
  | { kind: 'empty'; message: string }
  /** 取 Agent / 读清单时抛出的意外（与「清单格式异常」分开：前者要报障，后者要改 JSON） */
  | { kind: 'error'; message: string }
  | {
      kind: 'rows';
      rows: WorkProjectionRow[];
      /**
       * 行上方的说明行（报告层面的两种「不可当作零失效」态）
       *
       * 报告 `null`（尚未求值）/ `listReadable === false`（清单没读到）都**不是**「零失效」，
       * 必须各给一句话；报告正常且无失效时缺省（此时沉默才是准确的）。
       */
      notice?: { text: string; level: 'info' | 'warning' };
    };

/** webview → host 的动作名（同一条通道按 op 判别，不给每个按钮单开通道） */
export type WorkProjectionAction = 'load' | 'open' | 'toggle' | 'unregister';
