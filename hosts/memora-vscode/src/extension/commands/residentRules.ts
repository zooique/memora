/**
 * 命令：项目常驻规则（清单管理 + 单文件切换）
 *
 * 两条命令，同一套内核能力（本文件**只做「调用 + 显示结果」**）：
 *  - `memora.toggleResidentRule`：右键文件 / 编辑器标签切换该文件的常驻态；
 *  - `memora.manageResidentRules`：QuickPick 管理整份清单（切换 / 移除登记）。
 *
 * 🔴 纪律（宿主零判据）：
 *  1. **能不能常驻、超没超上限、文件在不在、当前是不是常驻** —— 全部由内核回答。
 *     本文件不得出现 `6000` / `15000` / 文件存在性 / `resident === true` 这类判断；
 *     常驻态一律读内核归一后的 `listManagedWorks().resident`（判据 = `isResidentEntry`）。
 *  2. 结果文案**原样展示**内核 message（七态 / 四态），宿主不改写、不归纳。
 *  3. URI → 相对路径**必须**走 `toWorkspaceRelativePath` 单点判据（禁用 `asRelativePath`）。
 *
 * 已知平台限制（诚实登记）：VS Code 的菜单标题是 `package.json` 静态贡献，**不支持按文件状态
 * 动态改文案**（`when` 只能读全局上下文键，读到的是「最后选中的文件」，会显示错误状态）。
 * 故右键项用中性标题「切换项目规则（常驻）」，当前态由 QuickPick 后缀与内核回执显式展示。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { toWorkspaceRelativePath } from '../host/workspaceRelativePath.js';

/** 内核结果面（结构对齐 setResident / unregisterWork，宿主只读这两字段） */
interface KernelResult {
  /** 粗粒度结果码（判据真源在内核，宿主只按成功态选提示通道） */
  reason: string;
  /** 人读文案（原样展示，禁止改写） */
  message: string;
}

/** 成功态结果码（仅决定用「信息」还是「错误」通道，不是能力判据） */
const SUCCESS_REASONS = new Set(['enabled', 'disabled', 'removed']);

/**
 * 展示内核回执
 *
 * 成功走轻提示，失败走错误提示；**message 原样透传**（文案真源在内核）。
 *
 * @param result 内核返回面
 */
function showKernelResult(result: KernelResult): void {
  if (SUCCESS_REASONS.has(result.reason)) {
    void vscode.window.showInformationMessage(result.message);
  } else {
    void vscode.window.showErrorMessage(result.message);
  }
}

/**
 * 切换单个文件的常驻态（右键 / 编辑器标签入口）
 *
 * @param uri 右键传入的目标（多选时为数组；命令面板调用为 undefined）
 * @param tryGetAgent 取当前工作区 Agent（失败返 null 不抛错，与其余命令同口径）
 */
export async function toggleResidentRuleCommand(
  uri: vscode.Uri | vscode.Uri[] | undefined,
  tryGetAgent: () => Promise<Agent | null>,
): Promise<void> {
  const uris = Array.isArray(uri) ? uri : uri ? [uri] : [];
  if (uris.length === 0) {
    void vscode.window.showWarningMessage('请在文件上右键，选择「Memora: 切换项目规则（常驻）」');
    return;
  }

  // 相对路径单点判据（首根语义；非首根 / 越界 / 跨盘当场拒绝，不静默截断）
  const relResult = toWorkspaceRelativePath(uris[0]!);
  if (!relResult.ok) {
    void vscode.window.showWarningMessage('无法切换项目规则：' + relResult.message);
    return;
  }
  const relativePath = relResult.relPath;

  const agent = await tryGetAgent();
  if (!agent?.works) {
    void vscode.window.showWarningMessage('Memora Agent 未就绪，无法切换项目规则');
    return;
  }

  try {
    // 当前态读内核归一结果（未登记 ⇒ 尝试置 true，由内核回 not-found + 指路文案）
    const entries = await agent.works.listManagedWorks();
    const current = entries.find((e) => e.source === relativePath);
    const nextResident = !current?.resident;
    showKernelResult(await agent.works.setResident(relativePath, nextResident));
  } catch (err) {
    // 只有「取清单 / 反序列化」这类意外会到这儿；setResident 自身的失败已由内核结果面承载
    void vscode.window.showErrorMessage(
      '切换项目规则失败：' + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** 管理清单条目（QuickPick 行；`source` / `resident` 直接来自内核快照） */
interface ManageItem extends vscode.QuickPickItem {
  /** 清单里的源路径（调用内核时原样回传） */
  source: string;
  /** 是否常驻（内核归一结果，宿主不二次判断） */
  resident: boolean;
}

/**
 * 打开一次清单选择器
 *
 * 回车 = 切换常驻；点条目右侧垃圾桶按钮 = 仅移除登记（不删源文件）。
 *
 * @param items 当前清单快照（每行的 buttons 已带「移除登记」按钮）
 * @returns 用户选择；取消 / 关闭返回 null
 */
function showManagePick(
  items: ManageItem[],
): Promise<{ item: ManageItem; action: 'toggle' | 'remove' } | null> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<ManageItem>();
    pick.title = 'Memora: 管理项目常驻规则';
    pick.placeholder = '回车切换常驻 / 点右侧按钮仅移除登记（不会删除源文件）';
    pick.items = items;
    /** 用户选择（关闭时据此回传） */
    let chosen: { item: ManageItem; action: 'toggle' | 'remove' } | null = null;
    pick.onDidAccept(() => {
      const selected = pick.selectedItems[0];
      if (selected) chosen = { item: selected, action: 'toggle' };
      pick.hide();
    });
    pick.onDidTriggerItemButton((event) => {
      chosen = { item: event.item, action: 'remove' };
      pick.hide();
    });
    pick.onDidHide(() => {
      pick.dispose();
      resolve(chosen);
    });
    pick.show();
  });
}

/**
 * 管理项目常驻规则（QuickPick：切换 / 移除登记）
 *
 * 每次动作后重新拉取清单，用户看到的是内核最新态（不在宿主侧维护镜像）。
 *
 * @param tryGetAgent 取当前工作区 Agent（失败返 null 不抛错）
 */
export async function manageResidentRulesCommand(
  tryGetAgent: () => Promise<Agent | null>,
): Promise<void> {
  const agent = await tryGetAgent();
  if (!agent?.works) {
    void vscode.window.showWarningMessage('Memora Agent 未就绪，无法管理项目常驻规则');
    return;
  }
  const works = agent.works;

  // 条目级按钮：语义在 tooltip 里写明「不删源文件」，避免与删除文件混淆
  const removeButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('trash'),
    tooltip: '仅从清单移除登记（不删除源文件）',
  };

  // 动作后回到清单（循环直到用户取消）；清单态始终来自内核
  for (;;) {
    let entries;
    try {
      entries = await works.listManagedWorks();
    } catch (err) {
      void vscode.window.showErrorMessage(
        '读取项目常驻规则清单失败：' + (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(
        '清单为空：先用「Memora: 登记作品投影」登记文件，再把它设为项目规则',
      );
      return;
    }

    const items: ManageItem[] = entries.map((e) => ({
      label: `${e.resident ? '$(check)' : '$(circle-outline)'} ${e.name}`,
      description: `${e.source} · ${e.resident ? '已常驻' : '未常驻'}`,
      detail: e.description,
      source: e.source,
      resident: e.resident,
      buttons: [removeButton],
    }));

    const picked = await showManagePick(items);
    if (!picked) return;

    if (picked.action === 'remove') {
      showKernelResult(await works.unregisterWork(picked.item.source));
    } else {
      showKernelResult(await works.setResident(picked.item.source, !picked.item.resident));
    }
  }
}

/**
 * 注册两条常驻规则命令（extension.ts 只留一次调用，不展开命令表）
 *
 * @param context 扩展上下文（订阅随停用自动释放）
 * @param tryGetAgent 取当前工作区 Agent 的闭包（与其余命令同源）
 */
export function registerResidentRuleCommands(
  context: vscode.ExtensionContext,
  tryGetAgent: () => Promise<Agent | null>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.toggleResidentRule', (uri) =>
      toggleResidentRuleCommand(uri as vscode.Uri | vscode.Uri[] | undefined, tryGetAgent),
    ),
    vscode.commands.registerCommand('memora.manageResidentRules', () =>
      manageResidentRulesCommand(tryGetAgent),
    ),
  );
}
