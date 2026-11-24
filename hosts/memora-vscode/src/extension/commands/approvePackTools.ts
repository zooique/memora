/**
 * 命令：批准角色包专属工具
 *
 * 背景（§8 设计真源）：角色包可在 `manifest.json` 的 `tools` 里声明专属工具，但**声明 ≠ 授权**——
 * 未批准的包内工具对模型不存在。本命令是宿主侧唯一的「批准 / 撤销批准」入口：
 *   - 列出**当前激活角色包**声明的全部专属工具，已批准的预选中；
 *   - 用户多选后写回 `memora.approvedPackTools`（绑定 包名 + 工具名 + 脚本内容 hash）；
 *   - 写回后立即同步内核，无需重开会话。
 *
 * 判据边界：本文件只做「列清单 + 写配置」，**不判断某个工具该不该注册**——是否注册由内核按三键
 * 匹配决定（`Agent.setRolePackToolApprovals`）。脚本 hash 由装配期算好（`tool.impl.scriptHash`），
 * 宿主不自己读文件算 hash（那是第二份真源）。
 */
import * as vscode from 'vscode';
import type { Agent, RolePackTool } from '@zooique/memora';
import {
  readApprovedPackTools,
  syncPackToolApprovals,
  writeApprovedPackTools,
} from '../host/packToolApproval.js';

/** QuickPick 行：携带对应的包内工具声明，供写回时取脚本 hash */
interface PackToolPickItem extends vscode.QuickPickItem {
  /** 该行对应的包内工具（装配期解析结果） */
  tool: RolePackTool;
}

/**
 * 批准 / 撤销批准当前角色包的专属工具
 *
 * 合并语义：**保留其它包的批准记录，整体替换当前包的记录**——用户在本命令里的勾选结果
 * 就是「当前包的全部批准」，未勾选的（含已存在但用户取消勾选的）会被移除。
 *
 * @param tryGetAgent 取当前工作区 Agent（失败返 null 不抛错，与其余命令同口径）
 */
export async function approvePackToolsCommand(
  tryGetAgent: () => Promise<Agent | null>,
): Promise<void> {
  const agent = await tryGetAgent();
  if (!agent?.rolePacks) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('Memora Agent is not ready; cannot approve role pack tools'),
    );
    return;
  }

  // 只处理当前激活包：批准记录以包为单位，切包后另一包的工具须另行批准
  const active = agent.rolePacks.getActive();
  const tools = active?.tools ?? [];
  if (!active) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('No role pack is active; nothing to approve'),
    );
    return;
  }
  if (tools.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The active role pack "{0}" declares no tools', active.meta.name),
    );
    return;
  }

  /** 已有的全部批准记录（其它包的记录需原样保留） */
  const existing = readApprovedPackTools();

  /** 当前包已批准的工具名集合（仅用于预勾选展示；命中须三键全等） */
  const approvedNames = new Set(
    existing.filter((a) => a.packName === active.meta.name).map((a) => a.toolName),
  );

  const items: PackToolPickItem[] = tools.map((tool) => ({
    label: tool.name,
    description: `${tool.group}${tool.readonly ? ' · readonly' : ''}`,
    detail: tool.description,
    // 预勾选：同名即视为已批准（hash 变化时内核会判回未批准，此处仍显示为已选，
    // 用户再次确认即写入新 hash——这正是「脚本更新后重新授权」的自然动线）
    picked: approvedNames.has(tool.name),
    tool,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: vscode.l10n.t('Memora: approve role pack tools'),
    placeHolder: vscode.l10n.t(
      'Checked tools are granted to the model (each call is still audited). Script updates require re-approval.',
    ),
  });
  // 用户取消（Esc / 关闭）：不改动任何已有批准
  if (!picked) return;

  // 合并：其它包原样保留 + 本包按勾选结果重建（含新 hash）
  const others = existing.filter((a) => a.packName !== active.meta.name);
  const next = [
    ...others,
    ...picked.map((p) => ({
      packName: active.meta.name,
      toolName: p.tool.name,
      scriptHash: p.tool.impl.scriptHash,
    })),
  ];

  await writeApprovedPackTools(next);
  // 直接同步一次：配置写回若与旧值相同则不会触发变更事件，此时仍需保证内核拿到最新集
  syncPackToolApprovals(agent);

  void vscode.window.showInformationMessage(
    vscode.l10n.t('Approved {0} tool(s) for role pack "{1}"', picked.length, active.meta.name),
  );
}
