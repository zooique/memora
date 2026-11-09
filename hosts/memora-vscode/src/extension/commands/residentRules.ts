/**
 * 命令：项目规则（清单管理 + 单文件切换）
 *
 * 两条命令，同一套内核能力（本文件**只做「调用 + 显示结果」**）：
 *  - `memora.toggleResidentRule`：右键文件 / 编辑器标签切换该文件的常驻态；
 *  - `memora.manageResidentRules`：QuickPick 管理整份清单（切换 / 移除登记）。
 *
 * 🔴 动作执行面 SSOT（WORK-PROJECTION-MOVE-1）：**翻转 / 移除 / 打开**三个动作的执行体
 * 收口在 `host/workProjectionBridge.ts` 的 `runWorkProjectionAction()`（动作集 =
 * `load | open | toggle | unregister`）。消费该执行面的入口 = 本文件的两个命令 +
 * 设置页「作品和规则」的行内按钮；它们的差异段只有「意图从哪来」。
 * ⚠️ **登记不属于该执行面**：资源管理器 / 命令面板的「登记作品投影」走
 * `registerWorkCommand` → `agent.works.registerWork`（含开框、多选、批量回执），
 * 不进 `runWorkProjectionAction` —— 「四入口共用执行面」是把两层折叠成一个词，勿再这样写。
 * 本文件只负责「URI → 首根相对路径」与「QuickPick → 选中项 source」这两段入口差异，
 * 禁止再写一份 `listManagedWorks + setResident` 循环（两份语义必然漂移）。
 * 侧边栏 TreeView 退役后，`toggleResidentRuleFromTree` / `unregisterWork` 两个树行命令
 * 及其 `WorkProjectionTreeItem` 载荷一并删除，不留双轨。
 *
 * 🔴 纪律（宿主零判据）：
 *  1. **能不能设为项目规则、超没超上限、文件在不在、当前是不是项目规则** —— 全部由内核回答。
 *     本文件不得出现字符上限数值 / 文件存在性 / `resident === true` 这类判断；
 *     项目规则态一律读内核归一后的 `listManagedWorks().resident`（判据 = `isResidentEntry`）。
 *  2. 结果文案的真源仍是内核结构化 `reason` 码：展示出口在 bridge 的 `showKernelResult`
 *     单点，按码渲染宿主本地化文案（内核 message 仅在未知码时兜底）。本文件不得自建文案。
 *  3. URI → 相对路径**必须**走 `toWorkspaceRelativePath` 单点判据（禁用 `asRelativePath`）。
 *
 * 已知平台限制（诚实登记）：VS Code 的菜单标题是 `package.json` 静态贡献，**不支持按文件状态
 * 动态改文案**（`when` 只能读全局上下文键，读到的是「最后选中的文件」，会显示错误状态）。
 * 故右键项用中性标题「切换项目规则」，当前态由 QuickPick 后缀与内核回执显式展示。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { toWorkspaceRelativePath } from '../host/workspaceRelativePath.js';
import { runWorkProjectionAction } from '../host/workProjectionBridge.js';
import { resolveCommandTitle } from '../host/manifestNls.js';

/**
 * 切换单个文件的常驻态（右键 / 编辑器标签入口）
 *
 * @param uri 右键传入的目标（多选时为数组；命令面板调用为 undefined）
 * @param tryGetAgent 取当前工作区 Agent（失败返 null 不抛错，与其余命令同口径）
 * @param toggleResidentRuleTitle 菜单标题原文（与命令面板同源，经 `resolveCommandTitle` 解析）
 */
export async function toggleResidentRuleCommand(
  uri: vscode.Uri | vscode.Uri[] | undefined,
  tryGetAgent: () => Promise<Agent | null>,
  toggleResidentRuleTitle: string,
): Promise<void> {
  const uris = Array.isArray(uri) ? uri : uri ? [uri] : [];
  if (uris.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Right-click a file and choose "{0}".', toggleResidentRuleTitle),
    );
    return;
  }

  // 相对路径单点判据（首根语义；非首根 / 越界 / 跨盘当场拒绝，不静默截断）
  const relResult = toWorkspaceRelativePath(uris[0]!);
  if (!relResult.ok) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Cannot toggle the project rule: {0}', vscode.l10n.t(relResult.message)),
    );
    return;
  }

  await runWorkProjectionAction('toggle', relResult.relPath, tryGetAgent);
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
    pick.title = vscode.l10n.t('Memora: manage project rules');
    pick.placeholder = vscode.l10n.t(
      'Enter toggles the project rule; the button on the right removes the entry only (the source file is kept)',
    );
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
 * 管理项目规则（QuickPick：切换 / 移除登记）
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
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Memora Agent is not ready; cannot manage project rules'),
    );
    return;
  }
  const works = agent.works;

  // 条目级按钮：语义在 tooltip 里写明「不删源文件」，避免与删除文件混淆
  const removeButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('trash'),
    tooltip: vscode.l10n.t('Remove from the list only (the source file is kept)'),
  };

  // 动作后回到清单（循环直到用户取消）；清单态始终来自内核
  for (;;) {
    let entries;
    try {
      entries = await works.listManagedWorks();
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Failed to load the project rule list: {0}',
          err instanceof Error ? err.message : String(err),
        ),
      );
      return;
    }
    if (entries.length === 0) {
      // 刻意不嵌「登记作品投影」菜单标题原文（ADR-042 后果第 2 条：嵌标题必须同源引用；
      // 此处拿不到该标题的解析链，改写避嵌比抄一遍标题原文更稳）
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'The list is empty. Register files via the work registration command first, then toggle them as project rules.',
        ),
      );
      return;
    }

    const items: ManageItem[] = entries.map((e) => ({
      label: `${e.resident ? '$(check)' : '$(circle-outline)'} ${e.name}`,
      description: `${e.source} · ${
        e.resident ? vscode.l10n.t('currently a project rule') : vscode.l10n.t('not a project rule')
      }`,
      detail: e.description,
      source: e.source,
      resident: e.resident,
      buttons: [removeButton],
    }));

    const picked = await showManagePick(items);
    if (!picked) return;

    // 与设置页行内按钮共用同一执行面；不在此处再调 works.setResident / unregisterWork
    await runWorkProjectionAction(
      picked.action === 'remove' ? 'unregister' : 'toggle',
      picked.item.source,
      tryGetAgent,
    );
  }
}

/**
 * 注册项目规则相关命令（extension.ts 只留一次调用，不展开命令表）
 *
 * @param context 扩展上下文（订阅随停用自动释放）
 * @param tryGetAgent 取当前工作区 Agent 的闭包（与其余命令同源）
 * @param onMutated 清单发生变更后的刷新回调（经 `notifyWorkProjectionChanged` 回推设置页）
 */
export function registerResidentRuleCommands(
  context: vscode.ExtensionContext,
  tryGetAgent: () => Promise<Agent | null>,
  onMutated?: () => void,
): void {
  // 命令标题注册期解析一次（ADR-042 后果第 2 条：守卫提示嵌标题必须与菜单同源）
  const toggleResidentRuleTitle = resolveCommandTitle(
    context.extensionUri.fsPath,
    vscode.env.language,
    'toggleResidentRule',
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('memora.toggleResidentRule', async (uri) => {
      await toggleResidentRuleCommand(
        uri as vscode.Uri | vscode.Uri[] | undefined,
        tryGetAgent,
        toggleResidentRuleTitle,
      );
      onMutated?.();
    }),
    vscode.commands.registerCommand('memora.manageResidentRules', async () => {
      await manageResidentRulesCommand(tryGetAgent);
      onMutated?.();
    }),
  );
}
