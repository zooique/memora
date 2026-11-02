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

/** 资产类型的中文标签（toast / 错误文案共用） */
function kindLabel(kind: AssetKind): string {
  return kind === 'skill' ? '技能' : '角色包';
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
    filters: { 压缩包: ['zip'] },
    openLabel: '导入',
    title: '选择要导入的技能或角色包压缩包（.zip）',
  });
  if (!picked || picked.length === 0) return;
  const zipPath = picked[0]!.fsPath;

  // ② 选目标级：项目目录由信任门单点给出；未信任时该选项明确标注原因（QuickPick 无真正置灰能力）
  const projectDirs = deps.readProjectDirs();
  const projectAvailable = Boolean(projectDirs.skills && projectDirs.rolePacks);
  const levelItems: LevelQuickPickItem[] = [
    {
      label: '用户级（默认）',
      description: '所有项目通用',
      detail: '写入全局用户目录；与项目级同名时，项目级仍优先',
      level: 'user',
    },
    {
      label: '项目级',
      description: projectAvailable ? '仅当前工作区' : '不可选：工作区未受信任',
      detail: projectAvailable
        ? '写入当前工作区 .memora 目录（优先级高于用户级）'
        : '需先在窗口中选择「信任工作区」后重试；未受信任时项目目录不会被加载',
      level: 'project',
    },
  ];
  const levelPick = await vscode.window.showQuickPick(levelItems, {
    placeHolder: '选择导入位置',
    title: '导入到哪一层',
  });
  if (!levelPick) return;
  if (levelPick.level === 'project' && !projectAvailable) {
    // 不静默降级为用户级：用户选了项目级，却写进用户目录属「落点与选择不一致」
    void vscode.window.showWarningMessage(
      '工作区未受信任，无法导入到项目级。请先信任当前工作区，或重新选择用户级。',
    );
    return;
  }

  /** 按资产类型解析目标根目录（类型由包内容识别，故不能在选文件前确定） */
  const targetRootFor = (kind: AssetKind): string => {
    if (levelPick.level === 'project') {
      const root = kind === 'skill' ? projectDirs.skills : projectDirs.rolePacks;
      // 上面已拦截未受信任的情形；此处断言仅为收窄类型（正常路径恒有值）
      if (!root) throw new Error('项目级目录未就绪（信任门判定与选项不一致）');
      return root;
    }
    return kind === 'skill' ? deps.userSkillsDir : deps.userRolePacksDir;
  };

  // Agent 只取一次：内置同名判定与写入后重扫共用同一实例（取两次会重复装配）
  const agent = await deps.tryGetAgent();

  // ③ 执行校验与落盘（包内容识别类型 → 内置同名判定 → 目标根 → 同名确认 → 暂存换名）
  const result = await importAssetZip(zipPath, {
    targetRootFor,
    confirmOverwrite: async (prompt) => {
      const choice = await vscode.window.showWarningMessage(
        `目标已存在：${prompt.targetPath}\n覆盖会备份并替换原内容，失败自动回滚，确定继续？`,
        { modal: true },
        '覆盖',
        '取消',
      );
      return choice === '覆盖';
    },
    isNameTaken: (name) => isBuiltinRolePackName(name, deps.builtinRolePacksDir, agent),
  });

  if (!result.ok) {
    // 失败必须给具体原因（zip-slip 条目名 / 超限 / 类型不符 / 校验失败各自可读）
    void vscode.window.showErrorMessage(`导入失败：${result.reason}`);
    return;
  }

  const { asset } = result;
  const root = targetRootFor(asset.kind);

  // ④ 重扫与 UI 刷新（写入是磁盘事实，重扫让内核池同步；Agent 未就绪时如实告知）
  if (!agent) {
    void vscode.window.showWarningMessage(
      `已导入${kindLabel(asset.kind)}「${asset.name}」到 ${asset.targetPath}，但 Memora Agent 未就绪，未能立即刷新；打开对话面板后会自动装载。`,
    );
  } else {
    try {
      await resyncImportedAsset(agent, asset.kind, levelPick.level, root);
    } catch (err) {
      // 落盘已成功，重扫失败不谎报「导入失败」——分开告知，用户可手动点「刷新」
      void vscode.window.showWarningMessage(
        `已导入${kindLabel(asset.kind)}「${asset.name}」，但刷新内核失败：${(err as Error).message}。请在设置页点击「刷新」。`,
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
    `导入成功：${kindLabel(asset.kind)}「${asset.name}」→ ${asset.targetPath}（${asset.fileCount} 个文件）`,
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
