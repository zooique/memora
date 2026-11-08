/**
 * 作品投影树 — TreeDataProvider（活动栏 Memora 容器内的常驻视图）
 *
 * 定位：把内核清单快照渲染成树；**派生形状全在 `workProjectionRows.ts`（纯函数、可单测）**，
 * 本文件只做三件 vscode 相关的事：取 Agent → 转 `TreeItem` → 发刷新事件。
 *
 * 🔴 纪律（宿主零判据）：
 *  1. 行内容一律来自内核 `listManagedWorks()`（`resident` 已归一），本文件不出现
 *     `resident === true` / 字符上限 / 文件存在性判断。
 *  2. 失效徽标读内核 `Agent.residentSegmentReport`（只读报告，不在宿主复算「哪条生效」）；
 *     报告为 null（还没跑过 turn / 整层未启用）或 `listReadable === false` 时，
 *     由派生层的 notice 行如实说明，**不得**显示成「零失效」。
 *  3. 刷新只由「本视图命令 / 登记命令」触发；不做文件监听（跨窗口手改落盘的时效性
 *     由 `memora.refreshWorkProjection` 手动兜底，与工作投影「最后落盘者胜」口径一致）。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import {
  deriveWorkProjectionView,
  type WorkProjectionRow,
  type WorkProjectionViewState,
} from './workProjectionRows.js';

/**
 * 树上「条目行」的 TreeItem 形态：额外携带回传载荷
 *
 * 右键菜单会把**被点击的 TreeItem** 原样作为第一个参数传给命令（无法注入自定义参数），
 * 故行数据必须挂在项上——命令侧据此拿到 `source` 回传内核，宿主不反解 label。
 */
export interface WorkProjectionTreeItem extends vscode.TreeItem {
  /** 该行对应的清单条目（纯数据，见 `WorkProjectionRow`；构造后写入，故非 readonly） */
  row: WorkProjectionRow;
}

/**
 * 作品投影树 provider
 *
 * 单实例挂在活动栏容器 `memora` 下；`refresh()` 由命令与登记动作调用（事件驱动，不轮询）。
 */
export class WorkProjectionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  /** 视图 id（与 `package.json` 的 `contributes.views.memora[].id` 同源，不在两处各写字面量） */
  static readonly viewType = 'memora.workProjection';

  /** 刷新事件源（`TreeDataProvider.onDidChangeTreeData` 的载体） */
  private readonly changed = new vscode.EventEmitter<void>();

  /** 刷新信号（vscode 在 `refresh()` 后重拉 `getChildren`） */
  readonly onDidChangeTreeData = this.changed.event;

  /**
   * @param tryGetAgent 取当前会话 Agent（装配失败返 null，不抛错；与命令侧同口径）
   */
  constructor(private readonly tryGetAgent: () => Promise<Agent | null>) {}

  /** 请求重拉整个视图（行数少，整树刷新比差量更新更简单且不会漂移） */
  refresh(): void {
    this.changed.fire();
  }

  /** 释放事件源（随扩展停用） */
  dispose(): void {
    this.changed.dispose();
  }

  /** 树项即行本身（provider 已构造好 TreeItem，无需二次派生） */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * 拉取子项：先派生状态（纯函数），再按状态转成「行」或「一条说明行」
   *
   * 三种非行状态都要能显示成树里的一行——否则空视图在 UI 上等于「坏了但不说为什么」。
   */
  async getChildren(): Promise<vscode.TreeItem[]> {
    let state: WorkProjectionViewState;
    try {
      const agent = await this.tryGetAgent();
      if (!agent?.works) {
        state = deriveWorkProjectionView({
          hasAgent: false,
          listMalformed: false,
          entries: [],
          residentReport: null,
        });
      } else {
        const works = agent.works;
        state = deriveWorkProjectionView({
          hasAgent: true,
          // 格式异常时内核拒绝写入：必须让用户看见，否则「登记后什么都没变」无法解释
          listMalformed: works.isFileMalformed,
          entries: await works.listManagedWorks(),
          // 规则求值报告（null = 尚未求值）；宿主不改写、不补算，只做形状翻译
          residentReport: agent.residentSegmentReport,
        });
      }
    } catch (err) {
      // 只有「取 Agent / 读清单」这类意外会到这儿；清单自身的格式错误已由内核降级为 isFileMalformed
      const detail = err instanceof Error ? err.message : String(err);
      return [this.infoItem('读取作品投影失败：' + detail, 'error')];
    }

    if (state.kind !== 'rows') {
      return [this.infoItem(state.message, state.kind === 'malformed' ? 'warning' : 'info')];
    }
    const items = state.rows.map((row) => this.rowItem(row));
    // 报告层面的说明行放在行上方：它是「整份报告可不可信」的前提，不是某一条的状态
    if (state.notice) items.unshift(this.infoItem(state.notice.text, state.notice.level));
    return items;
  }

  /**
   * 行 → TreeItem
   *
   * `contextValue` 供右键菜单 `viewItem` 判据；不带 `command`（点击不隐式改状态，
   * 避免「想看一眼却把规则关了」这种误触）。
   */
  private rowItem(row: WorkProjectionRow): vscode.TreeItem {
    const item = new vscode.TreeItem(
      row.name,
      vscode.TreeItemCollapsibleState.None,
    ) as WorkProjectionTreeItem;
    item.description = row.statusText;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.contextValue = row.contextValue;
    // 回传载荷（右键命令据此拿到 source；见 WorkProjectionTreeItem 的说明）
    item.row = row;
    return item;
  }

  /** 说明行（空态 / 错误态；不可展开，不参与右键动作） */
  private infoItem(message: string, level: 'info' | 'warning' | 'error'): vscode.TreeItem {
    const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
    );
    return item;
  }
}

/**
 * 注册作品投影 UI（树视图 + 手动刷新命令；extension.ts 只留一次调用）
 *
 * @param context 扩展上下文（订阅随停用自动释放）
 * @param tryGetAgent 取当前会话 Agent 的闭包（与命令同源）
 * @returns provider 实例（调用方在「清单被本进程改动后」调 `refresh()`）
 */
export function registerWorkProjectionUi(
  context: vscode.ExtensionContext,
  tryGetAgent: () => Promise<Agent | null>,
): WorkProjectionTreeProvider {
  const provider = new WorkProjectionTreeProvider(tryGetAgent);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(WorkProjectionTreeProvider.viewType, provider),
    // 手动刷新（视图标题按钮）：不做文件监听，跨窗口手改落盘靠这一下兜底
    vscode.commands.registerCommand('memora.refreshWorkProjection', () => provider.refresh()),
    provider,
  );
  return provider;
}
