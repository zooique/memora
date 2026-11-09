/**
 * 命令：导入资产压缩包（技能 / 角色包）——**三入口共用的唯一命令处理器**。
 *
 * 三个入口（命令面板 `memora.importAsset`、设置页技能区「导入 .zip」、设置页角色包区
 * 「导入 .zip」）都只做一件事：`executeCommand('memora.importAsset')`。差异段仅在于
 * 「用户从哪个页面点进来」，采集与执行全部归本文件 ⇒ 开框 / 选目标级 / 覆盖确认 / 重扫 / toast
 * 只有一份实现（第二份必漂移，且没有测试会红）。
 *
 * 职责分工：
 *   - 本文件 = 交互层（开文件框 / QuickPick 选目标级 / 覆盖确认弹窗 / toast）；
 *   - `host/userAssets/zipImport.ts` = 校验与落盘执行面（七步流水线，含 zip-slip / zip bomb 拦截）；
 *   - `host/userAssets/projectScope.ts` = 项目目录推导与信任门判据的**单点**（本文件不自行拼路径）。
 *
 * 信任门语义：项目级目标仅在 `projectAssetDirsFor` 返回目录时可选（未信任 / 无工作区均为空对象）
 * ⇒ 本文件不读 `vscode.workspace.isTrusted`，避免出现第二个信任判定点。
 */
import * as vscode from 'vscode';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '@zooique/memora';
import { importAssetZip, type AssetKind } from '../host/userAssets/zipImport.js';
import { confirmModal } from '../host/ui/confirmModal.js';
import type { ProjectAssetDirs } from '../host/userAssets/projectScope.js';
import { isPathWithin } from '../host/userAssets/path.js';
import type { MemoraChatViewProvider } from '../../webview/panels/chatPanel.js';
import type { MemoraSettingsPanel } from '../../webview/panels/settingsPanel.js';

/** 导入位置档位（用户级通用 / 当前工作区项目级） */
type ImportLevel = 'user' | 'project';

/** QuickPick 条目（附带档位字段，避免用显示文案反查档位） */
interface LevelQuickPickItem extends vscode.QuickPickItem {
  /** 该条目对应的导入档位 */
  level: ImportLevel;
}

/** 命令依赖（extension.ts 装配注入；全部为窄接口，便于单测替换） */
export interface ImportAssetDeps {
  /** 用户技能根目录（`<globalStorage>/skills`） */
  userSkillsDir: string;
  /** 用户角色包根目录（`<globalStorage>/role-packs`） */
  userRolePacksDir: string;
  /** 内置角色包根目录（`<configDir>/role-packs`）：同名判定用，命中即拒绝导入 */
  builtinRolePacksDir: string;
  /** 项目级目录的唯一读口（信任门判据同源于 `projectAssetDirsFor`；未信任时返回空对象） */
  readProjectDirs: () => ProjectAssetDirs;
  /** 取当前 Agent（未就绪返回 null——导入仍可落盘，但需如实告知未刷新） */
  tryGetAgent: () => Promise<Agent | null>;
  /** 对话视图（技能下拉刷新通道） */
  chatProvider: MemoraChatViewProvider;
  /** 设置面板（技能/角色包列表刷新通道） */
  settingsProvider: MemoraSettingsPanel;
}

/** 资产类型的标签（toast / 错误文案共用；切片 2 走 l10n——显式分支，键面守卫要求 t() 后紧跟字面量） */
function kindLabel(kind: AssetKind): string {
  return kind === 'skill' ? vscode.l10n.t('skill') : vscode.l10n.t('role pack');
}

/**
 * 内置角色包同名判定（导入前零写入拒绝的判据）
 *
 * 优先用内核池：`rolePackManager.get(name)` 的 `filePath` 落在内置目录 ⇒ 命中。
 * 但池内同名可能已被用户 / 项目包接管（后加载者胜），所以 `get` 只作快速命中；
 * 无论是否命中都再扫一遍内置目录清单（目录名或 manifest `name` 相同即算占用），
 * 保证「内置名字恒不可被导入包顶掉」不依赖当前激活态。
 *
 * Agent 未就绪时只用目录清单——判据不因装配状态而改变。
 *
 * @param name 待导入的角色包名（已净化）
 * @param builtinDir 内置角色包根目录
 * @param agent 已取到的 Agent（可能为 null）
 */
async function isBuiltinRolePackName(
  name: string,
  builtinDir: string,
  agent: Agent | null,
): Promise<boolean> {
  const pack = agent?.rolePackManager?.get(name);
  if (pack?.filePath && isPathWithin(builtinDir, pack.filePath)) return true;
  return builtinDirHasName(builtinDir, name);
}

/**
 * 内置角色包目录里是否已有同名包（目录名或 manifest `name` 相同）
 *
 * 目录不存在 / 读盘失败按「没有同名」处理：内置目录是随扩展分发的静态资源，
 * 缺失属安装异常，不应因此阻断用户导入。
 *
 * @param builtinDir 内置角色包根目录
 * @param name 待判定名字
 */
async function builtinDirHasName(builtinDir: string, name: string): Promise<boolean> {
  const dirs = await readdir(builtinDir, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    // 扫描器同样跳过 `.` / `_` 开头目录，它们不构成可装载包
    if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name.startsWith('_')) continue;
    if (dir.name === name) return true;
    try {
      const raw = await readFile(join(builtinDir, dir.name, 'manifest.json'), 'utf-8');
      if ((JSON.parse(raw) as { name?: unknown }).name === name) return true;
    } catch {
      // 无 manifest / 非法 JSON ⇒ 不是可装载包，跳过
    }
  }
  return false;
}

/**
 * 导入资产压缩包（命令实现）
 *
 * @param deps 宿主依赖（目录、Agent 取用、面板刷新）
 */
export async function importAssetCommand(deps: ImportAssetDeps): Promise<void> {
  // ① 选文件：只允许 .zip，单文件（多选会让「目标级 / 覆盖确认」语义变成 N 次追问）
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { [vscode.l10n.t('Archive')]: ['zip'] },
    openLabel: vscode.l10n.t('Import'),
    title: vscode.l10n.t('Select the skill or role-pack archive to import (.zip)'),
  });
  if (!picked || picked.length === 0) return;
  const zipPath = picked[0]!.fsPath;

  // ② 选目标级：项目目录由信任门单点给出；未信任时该选项明确标注原因（QuickPick 无真正置灰能力）
  const projectDirs = deps.readProjectDirs();
  const projectAvailable = Boolean(projectDirs.skills && projectDirs.rolePacks);
  const levelItems: LevelQuickPickItem[] = [
    {
      label: vscode.l10n.t('User level (default)'),
      description: vscode.l10n.t('Applies to all projects'),
      detail: vscode.l10n.t(
        'Writes to the global user directory; when a same-named project-level asset exists, the project level still wins',
      ),
      level: 'user',
    },
    {
      label: vscode.l10n.t('Project level'),
      description: projectAvailable
        ? vscode.l10n.t('This workspace only')
        : vscode.l10n.t('Unavailable: the workspace is not trusted'),
      detail: projectAvailable
        ? vscode.l10n.t(
            'Writes to the .memora directory of this workspace (takes priority over user level)',
          )
        : vscode.l10n.t(
            'Trust the workspace in this window first and retry; project directories are not loaded while untrusted',
          ),
      level: 'project',
    },
  ];
  const levelPick = await vscode.window.showQuickPick(levelItems, {
    placeHolder: vscode.l10n.t('Choose the import target'),
    title: vscode.l10n.t('Import to which level'),
  });
  if (!levelPick) return;
  if (levelPick.level === 'project' && !projectAvailable) {
    // 不静默降级为用户级：用户选了项目级，却写进用户目录属「落点与选择不一致」
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The workspace is not trusted; cannot import to project level. Trust the workspace first, or choose user level instead.',
      ),
    );
    return;
  }

  /** 按资产类型解析目标根目录（类型由包内容识别，故不能在选文件前确定） */
  const targetRootFor = (kind: AssetKind): string => {
    if (levelPick.level === 'project') {
      const root = kind === 'skill' ? projectDirs.skills : projectDirs.rolePacks;
      // 上面已拦截未受信任的情形；此处断言仅为收窄类型（正常路径恒有值）
      if (!root) throw new Error(vscode.l10n.t('project-level directory is not ready'));
      return root;
    }
    return kind === 'skill' ? deps.userSkillsDir : deps.userRolePacksDir;
  };

  // Agent 只取一次：内置同名判定与写入后重扫共用同一实例（取两次会重复装配）
  const agent = await deps.tryGetAgent();

  // ③ 执行校验与落盘（包内容识别类型 → 内置同名判定 → 目标根 → 同名确认 → 暂存换名）
  const result = await importAssetZip(zipPath, {
    targetRootFor,
    // 同名覆盖确认：只传「覆盖」；取消是 VS Code modal 自带的 Cancel（undefined ⇒ false），
    // 不再自拼「取消」item（那会造成 `[覆盖] [取消] [取消]`，见台账 MODAL-DUP-CANCEL-1）
    confirmOverwrite: (prompt) =>
      confirmModal({
        message: vscode.l10n.t('Target already exists: {0}', prompt.targetPath),
        detail: vscode.l10n.t(
          'Overwriting backs up and replaces the existing content; it rolls back automatically on failure. Continue?',
        ),
        confirmLabel: vscode.l10n.t('Overwrite'),
      }),
    isNameTaken: (name) => isBuiltinRolePackName(name, deps.builtinRolePacksDir, agent),
  });

  if (!result.ok) {
    // 失败必须给具体原因（zip-slip 条目名 / 超限 / 类型不符 / 校验失败各自可读）
    void vscode.window.showErrorMessage(vscode.l10n.t('Import failed: {0}', result.reason));
    return;
  }

  const { asset } = result;
  const root = targetRootFor(asset.kind);

  // ④ 重扫与 UI 刷新（写入是磁盘事实，重扫让内核池同步；Agent 未就绪时如实告知）
  if (!agent) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Imported {0} "{1}" to {2}, but the Memora Agent is not ready; it will load when the chat panel opens.',
        kindLabel(asset.kind),
        asset.name,
        asset.targetPath,
      ),
    );
  } else {
    try {
      await resyncImportedAsset(agent, asset.kind, levelPick.level, root);
    } catch (err) {
      // 落盘已成功，重扫失败不谎报「导入失败」——分开告知，用户可手动点「刷新」
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Imported {0} "{1}", but resyncing the kernel failed: {2}. Click "Refresh" in the settings view.',
          kindLabel(asset.kind),
          asset.name,
          (err as Error).message,
        ),
      );
    }
    if (asset.kind === 'skill') {
      deps.chatProvider.refreshSkillList();
      await deps.settingsProvider.refreshSkillList();
    } else {
      await deps.settingsProvider.refreshRolePackList();
    }
  }

  // ⑤ 成功 toast：类型 + 名称 + 落点 + 文件数
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Import succeeded: {0} "{1}" -> {2} ({3} file(s))',
      kindLabel(asset.kind),
      asset.name,
      asset.targetPath,
      asset.fileCount,
    ),
  );
}

/**
 * 重扫已导入资产（内核是扫描的唯一真源，本函数只做「按档位补齐登记 + 触发重扫」）
 *
 * - 技能：项目级先 `loadExtraDir(..., 'project')` 登记目录，再 `resyncUserSkills()` 重扫全部已登记目录；
 *   用户级目录在装配期已登记，直接重扫即可。
 * - 角色包：`resyncUserPacks(dir, tier)` 自带「未登记则按档位登记」语义，传档位即保证项目覆盖
 *   不被错记进用户覆盖分账。
 *
 * @param agent 已装配 Agent
 * @param kind 资产类型
 * @param level 导入档位
 * @param root 实际写入的根目录
 */
async function resyncImportedAsset(
  agent: Agent,
  kind: AssetKind,
  level: ImportLevel,
  root: string,
): Promise<void> {
  if (kind === 'skill') {
    if (level === 'project') await agent.skills?.loadExtraDir(root, 'project');
    await agent.skills?.resyncUserSkills();
    return;
  }
  await agent.rolePackManager?.resyncUserPacks(root, level === 'project' ? 'project' : 'user');
}
