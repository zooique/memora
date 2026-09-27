/**
 * 文件改动可视化（extension 侧 · VS Code 渲染与动作层）
 *
 * 设计依据：docs/方案-文件改动diff可视化-20260926.md（host-only，零内核改动）。
 *
 * **呈现形态 = 内联（in-place），不强制弹出 diff 窗口**（对齐 Trae / Qoder 的交互）：
 *   ① 打开真实文件进工作区（改动已生效）；
 *   ② 改动行**块级高亮**（绿底 + 左侧竖条）；
 *   ③ hunk 首行**行尾内联旧内容**（删除线灰字）+ **悬停看完整旧内容**（Markdown）——
 *      旧内容仅内存展示，文件中已不存在，全程不落盘；
 *   ④ **块级按钮**：每个改动块**末尾**一组「接受此处 / 拒绝此处」CodeLens，跟着改动走
 *      —— 改在哪一行，按钮就在哪一行旁边。⚠️ 旧稿写「每个 hunk 上方」：挂在 hunk **首行**
 *      时按钮会贴在**上一个 hunk 末尾**之下，被误读成「回退上一段」（2026-09-26 真机修正）。
 *      现挂在 `endLine + 1`：CodeLens 渲染在所在行**上方** ⇒ 视觉上紧跟该块**之后**，归属明确。
 *   ⑤ **文件级按钮**（确认本文件 / 回退本文件）放**编辑器标题栏**（`editor/title` 的
 *      `navigation` 组 = 标签栏右侧图标按钮），**不在文件正文里**——真机反馈「按钮嵌在文件里的
 *      感觉」。VS Code 扩展 API **没有**「编辑器内悬浮操作条」（Trae / Qoder 那条提示条是
 *      fork 内核级 UI，扩展层拿不到），标题栏是扩展能拿到的最接近形态。
 *
 * 三层粒度（对位 Qoder / Trae）：跨文件（对话区常驻条 / 状态栏 / 命令面板）→ 单文件（标题栏）
 * → 单处（块级 CodeLens）。**不要在文件里摆跨文件按钮**：粒度混淆（§11.3 已判过一次真伤）。
 *
 * `vscode.diff` 自 2026-09-27 起**不再使用**：「改动对照」改为自渲染的**统一视图（上下排列）**
 * 只读虚拟文档——左右并排在窄编辑器里把长行挤成两栏、看不清原文，而扩展 API 给不出
 * 「以 inline 布局打开 diff」的入口（理由与实证见 `formatUnifiedDiff`）。
 *
 * 关键边界：
 *   - 旧内容经 `TextDocumentContentProvider` 以**虚拟文档**交给 `vscode.diff`，**全程零落盘**
 *     （隐私：旧密钥不进磁盘、不进 git；无清理负担）。
 *   - 「恢复旧版」= 写回 beforeContent：**必须先经 `assertPathAllowed`**（与内核 SecurityGuard 同源），
 *     再走宿主原子写 `atomicWriteFileSync`；**不是**内核 `write_file` 处理器（该入口不存在）。
 *     因恢复是宿主直写、不产生 tool_start/tool_result → **无需 re-entrancy guard**（无自追踪回路）。
 *
 * ⚠️ 教训（2026-09-26 真机反馈）：装饰/动作**不得静默吞异常**——异常必须写日志，否则「文件打开了但
 * 看不到高亮」会没有任何诊断线索。装饰色用**字面高对比色**（不依赖主题色，明暗主题都可见）；
 * 设完装饰还必须 `revealRange` 把视口移过去，否则改动行不在视野内＝用户「看不出改了哪里」。
 *
 * @module fileChangeView
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import * as vscode from 'vscode';
// MAX_DIFF_CONTENT_LENGTH：对比预览上限的**单一真源**（内核 pathGuard 导出）。
// ⚠️ 两侧**超限行为不同**：内核 = 截断后追加「已截断」标记照常展示；宿主 = 跳过对比只提示——
// 只统一**数值**，不统一行为；不得据「同一常量」推论行为等价。
import { MAX_DIFF_CONTENT_LENGTH } from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';
import {
  applyHunkReverts,
  computeFileDiff,
  formatUnifiedDiff,
  hunkAnchorLine,
  hunkKey,
  isRemovedOnly,
  type DiffHunk,
} from './fileChangeDiff.js';
import {
  FileChangeTracker,
  type FileChangeRecord,
  type FileChangeSink,
  type ToolResultLike,
  type ToolStartLike,
} from './fileChangeTracker.js';

/** 行尾内联旧内容的最大展示字符数（超出省略号截断，完整内容走 hoverMessage） */
const INLINE_PREVIEW_MAX_CHARS = 72;

/** hoverMessage 里最多展示的旧行数（超出以「…」收尾，防超长内容撑爆悬停卡片） */
const HOVER_MAX_LINES = 30;

/** 虚拟文档 scheme（旧内容载体，不落盘） */
const VIRTUAL_SCHEME = 'memora-diff';

/** 状态栏入口命令 id（与 package.json#contributes.commands 一致） */
export const REVIEW_FILE_CHANGES_COMMAND = 'memora.reviewFileChanges';
/** 「全部确认」命令 id（面板/快捷方式入口） */
export const CONFIRM_ALL_FILE_CHANGES_COMMAND = 'memora.confirmAllFileChanges';
/**
 * 「全部回退」命令 id（对话区常驻条 / 命令面板入口）
 *
 * 安全等级与「全部确认」**不同级**：确认是纯内存清理（不写盘），而回退**会写盘且不可撤销**
 * ⇒ 实现内必带**模态二次确认**（见 `revertAll`），不得删；命令面板入口之所以也安全，正因
 * 无参数调用时它自身会弹模态确认、无记录时零动作。
 */
export const REVERT_ALL_FILE_CHANGES_COMMAND = 'memora.revertAllFileChanges';

/**
 * 文件级命令 id（宿主入口 = **编辑器标题栏**，故**必须**进 package.json#contributes.commands）
 *
 * 2026-09-27 真机反馈：这两颗按钮原先是文件正文里的 CodeLens，用户反馈「嵌在文件里的感觉」，
 * 遂迁到标题栏（`editor/title`）。代价是必须贡献声明（菜单依赖声明才渲染），从而**必须能承受
 * 无参调用**（命令面板 / 键绑定触发时没有 Uri）⇒ 无参时回落到**当前活动编辑器**的文件，
 * 取不到就留痕返回，不静默吞。
 */
export const CONFIRM_FILE_COMMAND = 'memora.fileChange.confirmFile';
export const RESTORE_FILE_COMMAND = 'memora.fileChange.restoreFile';

/**
 * 标题栏按钮的显隐上下文键（由 `setContext` 维护，`when` 子句消费）
 *
 * 为何需要它：标题栏菜单是**全局**的，不加 `when` 会在**每个**文件上都挂两颗按钮。
 * 键的语义 = 「当前活动编辑器这个文件有未确认改动」。
 */
export const PENDING_CONTEXT_KEY = 'memora.fileChangePending';

/**
 * 块级命令 id（**不进** package.json#contributes.commands）
 *
 * 参数是「文件绝对路径 + 块指纹」，只由块级 CodeLens 携带；暴露到命令面板会得到无参调用，
 * 而块指纹无从猜测 ⇒ 必然静默失败。故只 `registerCommand`，不贡献声明。
 */
export const CONFIRM_HUNK_COMMAND = 'memora.fileChange.confirmHunk';
export const REJECT_HUNK_COMMAND = 'memora.fileChange.rejectHunk';

/**
 * 改动行高亮装饰（字面高对比色，不依赖主题色）
 *
 * 绿色系（与「新增/修改」直觉一致）+ 左侧竖条 border，明暗主题下都清晰可见；
 * `isWholeLine` 使整行铺满。此前用主题色 `diffEditor.insertedTextBackground` 在部分主题下几乎不可见。
 *
 * ⚠️ **必须惰性构建，勿改回模块顶层常量**：`vscode.OverviewRulerLane` 是 VS Code 运行时枚举，
 * 放在模块顶层会在 **import 阶段**就求值。而本模块被「只想要命令 id 字符串」的导入方（对话面板
 * 提供者）间接引入——那些调用方在单测里只 mock 了最小 vscode API 子集，于是 **import 即抛错**，
 * 与是否真正调用本功能无关。惰性化后本模块可被任意最小 mock 环境安全导入。
 */
let highlightOptionsCache: vscode.DecorationRenderOptions | undefined;
function highlightOptions(): vscode.DecorationRenderOptions {
  highlightOptionsCache ??= {
    isWholeLine: true,
    backgroundColor: 'rgba(46, 160, 67, 0.18)',
    borderColor: 'rgba(46, 160, 67, 0.85)',
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    overviewRulerColor: 'rgba(46, 160, 67, 0.85)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  };
  return highlightOptionsCache;
}

/** 行尾内联旧内容的样式（删除线 + 灰红，明确「已不存在」语义） */
const INLINE_OLD_TEXT_STYLE: vscode.ThemableDecorationAttachmentRenderOptions = {
  color: 'rgba(214, 105, 105, 0.95)',
  textDecoration: 'line-through',
  fontStyle: 'italic',
  margin: '0 0 0 1.5em',
};

/** 恢复写回的路径守卫（结构对位内核 SecurityGuard.assertPathAllowed；避免直接依赖内核类型） */
export interface FileChangeSecurityGuard {
  assertPathAllowed(absolutePath: string, tool?: string, source?: 'builtin' | 'custom' | 'system'): void;
}

export interface FileChangeViewDeps {
  /** 取路径守卫（懒取，Agent 可能尚未装配） */
  getSecurityGuard: () => FileChangeSecurityGuard | undefined;
  /** 是否开启写前审批（confirmWrites）：开启时抑制自动打开（审批卡已展示） */
  isConfirmWrites: () => boolean;
  /** 诊断日志（接 Memora 输出通道；用于暴露装饰/打开等静默失败） */
  log: (message: string) => void;
}

interface ChangePickItem extends vscode.QuickPickItem {
  /** 记录（「全部确认」合成项除外） */
  record?: FileChangeRecord;
  /** 标记「全部确认」合成项 */
  all?: boolean;
}

type ChangeAction = 'compare' | 'restore' | 'confirm';

interface ActionPickItem extends vscode.QuickPickItem {
  action: ChangeAction;
}

/**
 * 单条回退的执行结果
 *
 * `dirty`（文件有未保存编辑、需用户确认）**单列一态**，不并入失败原因：它是「等用户拍板」
 * 而不是「出错了」——混进错误通道会被调用方当失败吞掉，或弹出误导性错误框。
 */
type RestoreOutcome =
  | { status: 'ok' }
  | { status: 'dirty' }
  | { status: 'failed'; reason: string };

/**
 * 取一行可安全用于装饰/CodeLens 的 range
 *
 * 空行（含文件末尾的空行）的 `TextLine.range` 是**空 range**，而装饰与 CodeLens 都要求非空
 * ——直接传会抛错。此处对空行扩到「下一行行首」，末行空行时越界由 VS Code clamp。
 */
function safeLineRange(document: vscode.TextDocument, line: number): vscode.Range {
  const last = Math.max(document.lineCount - 1, 0);
  const target = Math.min(Math.max(line, 0), last);
  const textLine = document.lineAt(target);
  if (!textLine.range.isEmpty) return textLine.range;
  return new vscode.Range(target, 0, target + 1, 0);
}

/** 一句话描述改动形态（QuickPick 副标题） */
function describeChange(rec: FileChangeRecord): string {
  if (rec.beforeContent === null) return '新建文件';
  if (rec.afterContent === null) return '删除文件';
  return rec.writeCount > 1 ? `已写入 · 共 ${rec.writeCount} 次` : '已写入';
}

/** 行尾内联预览文本（单行摘要；完整内容走 hover） */
function inlinePreview(removed: string[]): string | undefined {
  const head = removed[0];
  if (head === undefined) return undefined;
  const trimmed = head.trim();
  const clipped = trimmed.length > INLINE_PREVIEW_MAX_CHARS ? `${trimmed.slice(0, INLINE_PREVIEW_MAX_CHARS)}…` : trimmed;
  const rest = removed.length > 1 ? ` (+${removed.length - 1} 行)` : '';
  return `⟵ 原: ${clipped}${rest}`;
}

/**
 * 一次块计算的产物：**块列表 + 算它们时用的写后全文**
 *
 * 为什么要带上 `afterText`：`DiffHunk` 只有坐标与被删的旧行，**没有**块的新行内容，
 * 而块寻址指纹 `hunkKey` 需要它。指纹必须由**同一次计算**产出并在渲染/点击间传递——
 * 渲染时算一份、点击时再算一份 = 两份并列，必漂移（SSOT 违例）。
 */
interface HunkSnapshot {
  hunks: DiffHunk[];
  /** 算这些块时用的写后全文（`''` = 文件已删除 / 为空） */
  afterText: string;
}

/**
 * CodeLens provider：**每个改动块末尾一组按钮**（块级粒度，跟着改动走）
 *
 * 形态依据（2026-09-27 真机反馈）：用户要的是「按块独立显示按钮」。文件级的两颗按钮
 * 已迁到**编辑器标题栏**，故正文里只剩块级按钮——文件里摆文件级按钮会被读成「属于某一段」。
 *
 * 按钮带**块指纹**而非下标：渲染与点击之间内容可能已变（并行写同一文件、用户手改），
 * 按下标取块会**打错块且无报错**，而回退是写盘动作 ⇒ 打错块 = 吃掉用户内容。
 * 指纹对不上时命令实现走 fail-closed（不动盘、留痕、刷新按钮）。
 *
 * 块数据从注入的取值函数拿（复用 `FileChangeView` 的缓存），与装饰同源——两处各算一遍
 * diff 会漂移。
 */
class FileChangeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly snapshotOf: (absPath: string) => HunkSnapshot | undefined,
  ) {}

  get onDidChangeCodeLenses(): vscode.Event<void> {
    return this.emitter.event;
  }

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const absPath = document.uri.fsPath;
    const snapshot = this.snapshotOf(absPath);
    if (!snapshot || snapshot.hunks.length === 0) return [];
    const total = snapshot.hunks.length;
    return snapshot.hunks.flatMap((hunk, index) =>
      this.blockButtons(document, hunk, snapshot.afterText, absPath, index + 1, total),
    );
  }

  /**
   * 一组块级按钮：**接受此处 / 拒绝此处**（带「第 N/M 处」序号）
   *
   * 落点 = `endLine + 1`：CodeLens 渲染在所在行**上方** ⇒ 视觉上紧跟该块**之后**，归属唯一。
   * 挂在 hunk **首行**会被读成「属于上一段」（§11.8 已推翻的形态，勿回退）。
   * 纯删除块的 `endLine = startLine - 1` ⇒ 落点正好是删除位置，语义自洽，无需分支。
   *
   * ⚠️ **序号不是装饰，是位置无解时的补偿**（2026-09-27 真机反馈，硬证据）：
   * 文件**最后一行**没有「下一行」⇒ 末块的 `endLine + 1` 越界、只能 clamp 回块自己的末行，
   * 而 CodeLens 渲染在行的上方 ⇒ 末块按钮**必然落在该块上方**，这是 CodeLens 的固有约束
   * （VS Code 扩展 API 给不出「渲染在行下方」的 CodeLens）。用户原话「底部修改的按钮跑到上面
   * 去了」即此。位置解不了 ⇒ 让**归属不依赖位置**：序号直接说明「这个按钮管的是第几处」。
   * 序号顺带补上「看不出共几处」这个旧根因，故**恒显**（单块时 `1/1`），不搞时有时无。
   */
  private blockButtons(
    document: vscode.TextDocument,
    hunk: DiffHunk,
    afterText: string,
    absPath: string,
    ordinal: number,
    total: number,
  ): vscode.CodeLens[] {
    const range = safeLineRange(document, hunk.endLine + 1);
    const key = hunkKey(hunk, afterText);
    const suffix = `（${ordinal}/${total}）`;
    return [
      new vscode.CodeLens(range, {
        title: `$(check) 接受此处${suffix}`,
        command: CONFIRM_HUNK_COMMAND,
        arguments: [absPath, key],
      }),
      new vscode.CodeLens(range, {
        title: `$(discard) 拒绝此处${suffix}`,
        command: REJECT_HUNK_COMMAND,
        arguments: [absPath, key],
      }),
    ];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export class FileChangeView implements FileChangeSink {
  private readonly tracker: FileChangeTracker;
  private readonly deps: FileChangeViewDeps;
  /** 虚拟文档内容表：键 = 虚拟 URI.toString()，值 = 旧内容 */
  private readonly virtualContents = new Map<string, string>();
  /** 每条记录的高亮装饰类型（确认/恢复/重渲染时 dispose） */
  private readonly decorations = new Map<string, vscode.TextEditorDecorationType>();
  /**
   * 每条记录的逐行改动块缓存（渲染与 CodeLens **同源**消费，避免两处各算一遍）
   *
   * 值里带上「算这份 hunk 时用的写后内容」——并发写同一文件时缓存与 tracker 记录可能
   * 不同代，只按 path 命中会拿旧 hunk 去渲染（真机「部分改动没高亮」的成因之一）。
   *
   * ⚠️ **改基线（`beforeContent`）也必须 `delete` 本缓存**：缓存的命中键是 `afterText`，
   * 只改基线不改正文 ⇒ 键不变、却拿到旧块（被接受的块仍高亮）。改正文则键自然失效，无需额外处理。
   */
  private readonly hunkCache = new Map<string, HunkSnapshot>();
  /**
   * 每个文件的渲染序号
   *
   * 一个 step 里模型可能**并行多次写同一文件**（实测 insert + append 同 step 发出），
   * `noteToolResult` 会连着触发多次渲染；`openTextDocument` 是异步的，先发起的渲染可能
   * **后完成**并覆盖最新装饰 ⇒ 每个文件只允许**序号最新**的那次渲染落地。
   */
  private readonly renderSeq = new Map<string, number>();
  private readonly lensProvider: FileChangeCodeLensProvider;
  /** 未确认改动集变化广播（对话区常驻条数据源） */
  private readonly changeEmitter = new vscode.EventEmitter<readonly string[]>();
  private statusBar: vscode.StatusBarItem | undefined;

  /**
   * 未确认改动集变化事件（值为**相对项目根**的路径清单）
   *
   * 供宿主把常驻条状态推给对话区 webview。**只广播路径、不广播内容**——
   * 旧内容属敏感信息，仅在渲染需要时经虚拟文档按需取用。
   */
  readonly onDidChange: vscode.Event<readonly string[]> = this.changeEmitter.event;

  constructor(tracker: FileChangeTracker, deps: FileChangeViewDeps) {
    this.tracker = tracker;
    this.deps = deps;
    this.lensProvider = new FileChangeCodeLensProvider((absPath) => this.snapshotOfPath(absPath));
  }

  /** 注册虚拟文档 provider / CodeLens / 状态栏 / 命令（幂等；返回值随扩展上下文释放） */
  register(context: vscode.ExtensionContext): void {
    const provider = vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_SCHEME, {
      provideTextDocumentContent: (uri: vscode.Uri): string => this.virtualContents.get(uri.toString()) ?? '',
    });
    const lensRegistration = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.lensProvider);
    const reviewCommand = vscode.commands.registerCommand(REVIEW_FILE_CHANGES_COMMAND, () => {
      void this.showChangeList();
    });
    const confirmAllCommand = vscode.commands.registerCommand(CONFIRM_ALL_FILE_CHANGES_COMMAND, () => {
      this.confirmAll();
    });
    const revertAllCommand = vscode.commands.registerCommand(REVERT_ALL_FILE_CHANGES_COMMAND, () => {
      void this.revertAll();
    });
    const confirmFile = vscode.commands.registerCommand(CONFIRM_FILE_COMMAND, (arg: unknown) => {
      this.withRecord(arg, (rec) => this.confirmChange(rec));
    });
    const restoreFile = vscode.commands.registerCommand(RESTORE_FILE_COMMAND, (arg: unknown) => {
      this.withRecord(arg, (rec) => void this.restoreChange(rec));
    });
    const confirmHunk = vscode.commands.registerCommand(
      CONFIRM_HUNK_COMMAND,
      (arg: unknown, key: unknown) => {
        this.withHunk(arg, key, (rec, hunk) => this.acceptHunk(rec, hunk));
      },
    );
    const rejectHunk = vscode.commands.registerCommand(
      REJECT_HUNK_COMMAND,
      (arg: unknown, key: unknown) => {
        this.withHunk(arg, key, (rec, hunk) => void this.rejectHunk(rec, hunk));
      },
    );
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = REVIEW_FILE_CHANGES_COMMAND;
    this.statusBar.name = 'Memora 文件改动';
    // 装饰绑定在**编辑器实例**上，切走再切回不会自动恢复（CodeLens 走 provider 模式则不受影响）
    // ⇒ 可见编辑器集合变化时必须主动补齐，否则「切个文件回来，高亮全没、只剩按钮」
    const editorWatcher = vscode.window.onDidChangeVisibleTextEditors(() => this.reapplyDecorations());
    // 标题栏按钮的显隐跟「当前活动文件有没有未确认改动」走 ⇒ 活动编辑器一变就得重算上下文键
    const activeWatcher = vscode.window.onDidChangeActiveTextEditor(() => this.syncPendingContext());
    context.subscriptions.push(
      provider,
      lensRegistration,
      reviewCommand,
      confirmAllCommand,
      revertAllCommand,
      confirmFile,
      restoreFile,
      confirmHunk,
      rejectHunk,
      editorWatcher,
      activeWatcher,
      this.statusBar,
      {
        dispose: (): void => this.dispose(),
      },
    );
    this.refreshStatusBar();
    this.syncPendingContext();
  }

  /** 当前未确认改动的相对路径清单（快照；供 webview ready 时补推，防「时间面」漏面） */
  snapshotFiles(): string[] {
    return this.tracker.list().map((rec) => rec.relPath);
  }

  /**
   * 广播改动集变化
   *
   * 所有会改变记录集的路径都必须调；**批量操作由调用方统一收口成一次**
   * （如 `confirmAll` 循环内传 `notify=false`），避免 N 次 postMessage 触发 webview N 次重渲染。
   *
   * 上下文键（标题栏按钮显隐）也在这里同步：它的取值 = 「活动文件是否有未确认改动」，
   * 记录集一变就可能变 ⇒ 挂在同一个广播点上，不另设一处维护（两处必漂移）。
   */
  private notifyChanged(): void {
    this.changeEmitter.fire(this.snapshotFiles());
    this.syncPendingContext();
  }

  /**
   * 同步标题栏按钮的显隐上下文键
   *
   * `editor/title` 菜单是**全局**的，不加 `when` 会在每个文件上都挂两颗按钮 ⇒ 用 `setContext`
   * 把「当前活动文件有未确认改动」写进 when 上下文。
   */
  private syncPendingContext(): void {
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const pending = active !== undefined && this.tracker.get(active) !== undefined;
    void vscode.commands.executeCommand('setContext', PENDING_CONTEXT_KEY, pending);
  }

  /**
   * 命令参数 → 文件绝对路径（三种入口同一命令，故必须归一化）
   *
   *   - CodeLens / webview：绝对路径**字符串**；
   *   - `editor/title` 菜单：VS Code 传 **Uri**（`fsPath` 可用）；
   *   - 命令面板 / 键绑定：**无参** ⇒ 回落到当前活动编辑器的文件。
   *
   * 取不到就返回 undefined 由调用方留痕；**不猜**、不拿第一个记录顶替（那会动到别的文件）。
   */
  private pathOf(arg: unknown): string | undefined {
    if (typeof arg === 'string') return arg;
    if (arg !== null && typeof arg === 'object') {
      const fsPath = (arg as { fsPath?: unknown }).fsPath;
      if (typeof fsPath === 'string') return fsPath;
    }
    return vscode.window.activeTextEditor?.document.uri.fsPath;
  }

  /** 命令参数守卫：归一化出路径后交给 tracker 判空；非法参数留痕忽略 */
  private withRecord(arg: unknown, run: (rec: FileChangeRecord) => void): void {
    const absPath = this.pathOf(arg);
    if (absPath === undefined) {
      this.deps.log('[fileChange] 命令无法定位文件（无参数且无活动编辑器），已忽略');
      return;
    }
    const rec = this.tracker.get(absPath);
    if (!rec) return;
    run(rec);
  }

  /**
   * 块级命令参数守卫：路径之外还必须有**块指纹**
   *
   * 指纹缺失（无参调用 / 版本不匹配）一律 fail-closed——没有指纹就只能按下标猜块，
   * 而块级回退是**写盘**动作，猜错 = 吃掉用户内容且无任何报错。
   */
  private withHunk(
    pathArg: unknown,
    keyArg: unknown,
    run: (rec: FileChangeRecord, key: string) => void,
  ): void {
    if (typeof keyArg !== 'string') {
      this.deps.log('[fileChange] 块级命令缺少块指纹，已忽略（不按猜测定块）');
      return;
    }
    this.withRecord(pathArg, (rec) => run(rec, keyArg));
  }

  // ─── FileChangeSink：chatPanel 唯一接入点 ───

  noteToolStart(chunk: ToolStartLike): void {
    this.tracker.noteToolStart(chunk);
  }

  noteToolResult(chunk: ToolResultLike): void {
    const before = this.tracker.size();
    const record = this.tracker.noteToolResult(chunk);
    if (!record) return;
    // 内容已变 → 缓存的改动块与 CodeLens 全部失效，必须重算（否则装饰停在旧范围）
    this.hunkCache.delete(record.path);
    // 本次写入可能触发上限淘汰 → 渲染层缓存/装饰按存活集对齐
    this.reconcile();
    this.refreshStatusBar();
    this.lensProvider.refresh();
    this.notifyChanged();
    // 写前审批开启时，审批卡已展示 diff；此处抑制自动打开，避免双呈现（§3.3）
    if (this.deps.isConfirmWrites()) return;
    void this.revealChange(record);
    // 本轮首个改动（0 → >0）：弹带按钮的通知——解决「没有按钮」的可发现性缺口
    if (before === 0) this.notifyChange(record);
  }

  // ─── 渲染 ───

  /**
   * 打开真实文件 + 内联呈现（**不自动弹 diff 窗口**；对比视图改为按需）
   *
   * 并发安全（2026-09-26 真机修正）：一个 step 内模型可能**并行多次写同一文件**
   * （实测：insert + append 在同一 step 发出，`noteToolResult` 连着触发两次本方法）。
   * `openTextDocument` 是异步的 ⇒ 若不加守卫，先发起的渲染可能**后完成**并覆盖最新装饰，
   * 用户看到的就是「只有部分改动有高亮」。两道守卫：
   *   ① **渲染序号**：每个文件只允许最新一次渲染落地；
   *   ② await 之后**重取最新记录**（tracker 是唯一真源），不拿发起时的旧快照去渲染。
   *
   * 磁盘同步：内核直接写盘、不经编辑器，VS Code 的文档缓存可能仍是写入前的内容 ⇒ 坐标系
   * 错位会让高亮画到错误的行上。**未修改（非 dirty）**的文档直接从磁盘重载；用户正在编辑
   * 则不动它，只如实呈现现状（并在 `renderInline` 留痕）。
   */
  private async revealChange(rec: FileChangeRecord): Promise<void> {
    if (rec.afterContent === null) return; // 已删除：无文件可打开（可在入口中「恢复旧版」）
    const seq = (this.renderSeq.get(rec.path) ?? 0) + 1;
    this.renderSeq.set(rec.path, seq);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rec.path));
      if (!this.isLatestRender(rec.path, seq)) return; // 已有更新的写入在途，本次渲染作废
      const latest = this.tracker.get(rec.path);
      if (!latest || latest.afterContent === null) return; // 已被确认 / 回退 / 删除
      if (!doc.isDirty && doc.getText() !== latest.afterContent) {
        // 文档未被用户改动 → 重载到磁盘最新内容，保证装饰坐标系与所见文本一致
        await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
      }
      // showTextDocument 让该文档进入 visibleTextEditors——`renderInline` 依据可见编辑器逐个设置装饰
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
      if (!this.isLatestRender(rec.path, seq)) return;
      this.renderInline(this.tracker.get(rec.path) ?? latest, doc, true);
    } catch (err) {
      // 不再静默：打开/装饰失败必须留痕（真机「打开了但无高亮」曾因此无诊断线索）
      this.deps.log(`[fileChange] 打开/渲染失败 ${rec.relPath}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 本文件的渲染序号是否仍是最新（并发写同一文件时只让最后发起的那次渲染落地） */
  private isLatestRender(absPath: string, seq: number): boolean {
    return this.renderSeq.get(absPath) === seq;
  }

  /**
   * 内联呈现：改动行高亮 + 首行行尾旧内容 + 悬停全文 +（可选）视口定位
   *
   * 装饰项与 `hunkCache` 同源（CodeLens 也读同一份），确保「高亮的位置」与「按钮的位置」永不漂移。
   *
   * ⚠️ **装饰项是 per-editor 的**：`setDecorations` 只作用于**调用时的那个编辑器**。
   * 同一文档可能同时显示在多个编辑器（分屏、或切走再切回后 VS Code 重建的编辑器实例），
   * 因此这里对**所有可见的该文档编辑器**逐个设置——只设一个会导致「换个文件再切回来，
   * 高亮全没了（CodeLens 却还在，因为它走 provider 模式由 VS Code 主动重算）」。
   *
   * @param reveal 是否移动视口定位到首个改动块；由编辑器可见性变化触发的重设**必须传 false**
   *               （用户只是切回来看，不该被强行滚动）。
   */
  private renderInline(rec: FileChangeRecord, doc: vscode.TextDocument, reveal: boolean): void {
    try {
      this.clearDecoration(rec.path);
      // 走到这里仍不一致 = 用户正在编辑（dirty，`revealChange` 刻意不重载它）或重载失败 ⇒
      // 坐标系与所见文本必然错位，必须留痕，否则下次仍是无诊断线索的「显示不正确」。
      if (rec.afterContent !== null && doc.getText() !== rec.afterContent) {
        this.deps.log(`[fileChange] 文档已被改动或重载失败（高亮范围可能错位）${rec.relPath}`);
      }
      const hunks = this.snapshotFor(rec).hunks;
      if (hunks.length === 0) return;
      const decorationType = vscode.window.createTextEditorDecorationType(highlightOptions());
      this.decorations.set(rec.path, decorationType);

      const items = this.buildDecorationItems(doc, hunks);
      const targets = vscode.window.visibleTextEditors.filter(
        (editor) => editor.document.uri.toString() === doc.uri.toString(),
      );
      for (const editor of targets) editor.setDecorations(decorationType, items);

      if (!reveal || targets.length === 0) return;
      const anchor = this.anchorRange(doc, hunks);
      if (!anchor) return;
      const target = targets.find((editor) => editor === vscode.window.activeTextEditor) ?? targets[0];
      target.revealRange(anchor, vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      this.deps.log(`[fileChange] 装饰应用失败 ${rec.relPath}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 逐行装饰项（块内每行铺底；首行额外带行尾旧内容 + 悬停全文） */
  private buildDecorationItems(doc: vscode.TextDocument, hunks: DiffHunk[]): vscode.DecorationOptions[] {
    const items: vscode.DecorationOptions[] = [];
    for (const hunk of hunks) {
      const first = hunkAnchorLine(hunk, doc.lineCount);
      if (isRemovedOnly(hunk)) {
        // 纯删除：新文件中已无对应行 → 把旧内容挂到删除位置的锚点行
        items.push(this.decorationFor(doc, first, hunk));
        continue;
      }
      for (let line = hunk.startLine; line <= hunk.endLine; line += 1) {
        items.push(line === hunk.startLine ? this.decorationFor(doc, line, hunk) : { range: safeLineRange(doc, line) });
      }
    }
    return items;
  }

  /** 首个改动块的定位锚点（视口滚到这里） */
  private anchorRange(doc: vscode.TextDocument, hunks: DiffHunk[]): vscode.Range | undefined {
    const first = hunks[0];
    return first ? safeLineRange(doc, hunkAnchorLine(first, doc.lineCount)) : undefined;
  }

  /**
   * 编辑器可见集变化后补齐装饰（切文件 / 切回 / 分屏）
   *
   * 起因（2026-09-26 真机）：切换查看其他文件再切回源文件，**高亮全部消失、只剩 CodeLens 按钮**。
   * 根因 = 装饰项绑在编辑器实例上，VS Code 不会在编辑器重新可见时替你恢复；而 CodeLens 走
   * provider 模式（`provideCodeLenses` 由 VS Code 主动调用）不受影响 ⇒ 只有高亮丢了。
   * 同一个文件可能同时出现在多个编辑器里，故按路径去重后逐个补齐。
   */
  private reapplyDecorations(): void {
    const seen = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri;
      if (uri.scheme !== 'file' || seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      const rec = this.tracker.get(uri.fsPath);
      if (rec) this.renderInline(rec, editor.document, false);
    }
  }

  /** 带旧内容附件与悬停说明的单行装饰 */
  private decorationFor(doc: vscode.TextDocument, line: number, hunk: DiffHunk): vscode.DecorationOptions {
    const options: vscode.DecorationOptions = {
      range: safeLineRange(doc, line),
      hoverMessage: this.oldContentHover(hunk),
    };
    const preview = inlinePreview(hunk.removed);
    if (preview) {
      options.renderOptions = { after: { ...INLINE_OLD_TEXT_STYLE, contentText: `  ${preview}` } };
    }
    return options;
  }

  /** 悬停展示完整旧内容（旧内容只存在于内存，不落盘） */
  private oldContentHover(hunk: DiffHunk): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    if (hunk.removed.length === 0) {
      md.appendMarkdown('**本次新增**（此处原本没有内容）');
      return md;
    }
    md.appendMarkdown('**改动前的原内容**（已不在文件中，仅用于对照）\n\n');
    const shown = hunk.removed.slice(0, HOVER_MAX_LINES);
    md.appendCodeblock(shown.join('\n'), 'text');
    if (hunk.removed.length > HOVER_MAX_LINES) {
      md.appendMarkdown(`\n…另有 ${hunk.removed.length - HOVER_MAX_LINES} 行已省略`);
    }
    return md;
  }

  /** 取（并缓存）某条记录的块快照；超限降级时留痕。写后内容一变即重算（见 `hunkCache` 注释） */
  private snapshotFor(rec: FileChangeRecord): HunkSnapshot {
    const afterText = rec.afterContent ?? '';
    const cached = this.hunkCache.get(rec.path);
    if (cached && cached.afterText === afterText) return cached;
    const diff = computeFileDiff(rec.beforeContent ?? '', afterText);
    if (diff.degraded) {
      this.deps.log(`[fileChange] ${rec.relPath} 改动过大，已降级为整体高亮（逐行对照跳过）`);
    }
    const snapshot: HunkSnapshot = { hunks: diff.hunks, afterText };
    this.hunkCache.set(rec.path, snapshot);
    return snapshot;
  }

  /** CodeLens 的数据源：按路径取当前记录的块快照（文档打开顺序无关，可独立计算） */
  private snapshotOfPath(absPath: string): HunkSnapshot | undefined {
    const rec = this.tracker.get(absPath);
    if (!rec) return undefined;
    return this.snapshotFor(rec);
  }

  /**
   * 按**块指纹**定位一块（渲染 → 点击的寻址唯一收口）
   *
   * 找不到就返回 undefined，调用方一律 **fail-closed**（不动盘、留痕、刷新按钮）。
   * 绝不退化成「按下标猜一个」——回退是写盘动作，猜错即吃掉用户内容且无报错。
   */
  private resolveHunk(
    rec: FileChangeRecord,
    key: string,
  ): { snapshot: HunkSnapshot; hunk: DiffHunk } | undefined {
    const snapshot = this.snapshotFor(rec);
    const hunk = snapshot.hunks.find((candidate) => hunkKey(candidate, snapshot.afterText) === key);
    return hunk ? { snapshot, hunk } : undefined;
  }

  /**
   * 渲染层缓存与装饰对齐 tracker 存活集
   *
   * tracker 有上限淘汰（`evictOverflow`，默认 100 条）——记录被淘汰时渲染层**不知情**，
   * `hunkCache` 与 `decorations` 会残留。功能上无害（`hunksOfPath` 先经 `tracker.get` 判空，
   * 陈旧缓存永不被消费），但内存与已废弃的装饰不回收。淘汰的唯一发生点是 `noteToolResult`
   * （`evictOverflow` 只在那里被调），故只在该处对齐一次，不额外挂全局监听。
   */
  private reconcile(): void {
    const alive = new Set(this.tracker.list().map((rec) => rec.path));
    for (const key of [...this.hunkCache.keys()]) {
      if (!alive.has(key)) this.hunkCache.delete(key);
    }
    for (const key of [...this.decorations.keys()]) {
      if (!alive.has(key)) this.clearDecoration(key);
    }
  }

  private clearDecoration(absPath: string): void {
    const decorationType = this.decorations.get(absPath);
    if (decorationType) {
      decorationType.dispose();
      this.decorations.delete(absPath);
    }
  }

  /**
   * 打开**改动对照**：自渲染的**统一视图（上下排列）**，只读虚拟文档，零落盘
   *
   * 形态依据（2026-09-27 真机反馈「左右排列看不清原文」）：`vscode.diff` 是左右并排，
   * 长行被挤成两个窄栏。扩展 API 拿不到「以 inline 布局打开」的入口（见 `formatUnifiedDiff`
   * 的注释：第 4 参数不含布局，改布局只能动用户全局设置或盲调切换型命令）⇒ 自己渲染。
   *
   * 内容仍经 `TextDocumentContentProvider` 走**虚拟文档**：旧内容不进磁盘、不进 git，
   * 且虚拟文档天然只读（不会让用户在对照页上误编辑）。
   *
   * 超限行为（与内核不同）：跳过对照、只提示可回退——阈值 = 内核 `MAX_DIFF_CONTENT_LENGTH`。
   * ⚠️ 两侧长度**都要判**：删除场景 `afterContent === null`，但旧内容本身可能是大文件，
   * 同样要进虚拟文档渲染。
   */
  private async openCompare(rec: FileChangeRecord): Promise<void> {
    const beforeText = rec.beforeContent ?? '';
    const afterText = rec.afterContent ?? '';
    if (Math.max(beforeText.length, afterText.length) > MAX_DIFF_CONTENT_LENGTH) {
      void vscode.window.showInformationMessage(`Memora：${rec.relPath} 改动过大，已跳过对比预览（可「回退」）`);
      return;
    }
    const fileName = basename(rec.path);
    const uri = this.virtualUriFor(this.compareSeed(rec.path), `对照-${fileName}`);
    this.virtualContents.set(uri.toString(), formatUnifiedDiff(beforeText, afterText, `${rec.relPath} — 本次改动（上下对照）`));
    await vscode.window.showTextDocument(uri, { preview: false });
  }

  /** 虚拟 URI（键 = seed 的 hash；尾部保留文件名与扩展名供语言推断） */
  private virtualUriFor(seed: string, fileName: string): vscode.Uri {
    const hash = createHash('sha1').update(seed).digest('hex').slice(0, 12);
    return vscode.Uri.from({ scheme: VIRTUAL_SCHEME, path: `/${hash}/${fileName}` });
  }

  /** 对照文档的 seed（与「其余虚拟文档」区分，避免同 URI 互相覆盖） */
  private compareSeed(absPath: string): string {
    return `${absPath}#compare`;
  }

  /** 精确释放某条记录占用的虚拟文档内容（**不误伤其它记录**的对照视图） */
  private releaseVirtual(rec: FileChangeRecord): void {
    const fileName = basename(rec.path);
    this.virtualContents.delete(this.virtualUriFor(this.compareSeed(rec.path), `对照-${fileName}`).toString());
  }

  // ─── 动作 ───

  /**
   * 注销一条记录并释放它占用的全部渲染资源（**不碰任何 UI 刷新**）
   *
   * 三个消费者（单文件确认 / 全部确认 / 恢复旧版）共用这一个清理序列——各写一份必漂移
   * （漏清装饰即残留高亮，漏清虚拟文档即旧内容驻留内存）。**UI 刷新归调用方**：
   * 批量入口在循环内逐条刷新会带来 N 次状态栏重绘 + N 次 CodeLens 事件。
   */
  private discardRecord(rec: FileChangeRecord): void {
    this.clearDecoration(rec.path);
    this.releaseVirtual(rec);
    this.hunkCache.delete(rec.path);
    // 记录没了 ⇒ 作废在途渲染（否则可能给已确认/已回退的文件重新画上高亮）
    this.renderSeq.delete(rec.path);
    this.tracker.drop(rec.path);
  }

  /** 「确认」：关对比视图 + 清装饰 + 注销记录（= 用户已接受本次改动） */
  private confirmChange(rec: FileChangeRecord): void {
    this.discardRecord(rec);
    this.refreshStatusBar();
    this.lensProvider.refresh();
    this.notifyChanged();
  }

  /** 「全部确认」：一次性确认所有未确认改动（纯内存清理，零风险，无需二次确认） */
  private confirmAll(): void {
    const records = this.tracker.list();
    if (records.length === 0) {
      void vscode.window.showInformationMessage('Memora：当前没有未确认的文件改动');
      return;
    }
    for (const rec of records) this.discardRecord(rec);
    // 批量刷新收口：循环内不刷新，结束统一一次（防 N 次状态栏重绘 / N 次 CodeLens 事件）
    this.refreshStatusBar();
    this.lensProvider.refresh();
    this.notifyChanged();
    void vscode.window.showInformationMessage(`Memora：已确认全部 ${records.length} 处改动`);
  }

  /**
   * 「全部回退」：把所有文件写回 agent 介入之前的内容（**破坏性操作，必带模态二次确认**）
   *
   * 与「全部确认」的安全等级不同：确认只清内存，回退**写盘且不可撤销**——原始为新建的文件会
   * 被**删除**，其余文件会被**覆盖**（连带用户在改动之后的手动编辑一并丢失，无 git 时无法找回）。
   * 故必须：① 模态确认 + 明细（文件清单、其中多少个会被删除）；② 逐个执行、**单个失败不中断**整批；
   * ③ 结束时汇总成败（而不是弹 N 个错误框）。
   *
   * 🔴 **未保存编辑**：先扫出全部「已打开且 dirty」的文件、在**同一个模态**里一次列出
   * （只弹一次，不逐个追问）；用户确认即视为对列出的 dirty 文件一并授权。`overwriteDirty`
   * **只放行清单内的文件**——确认之后才变 dirty 的文件仍被 `applyRestore` 的 fail-closed
   * 闸拦下并如实报「失败（有未保存编辑）」，不静默吞。
   */
  private async revertAll(): Promise<void> {
    const records = this.tracker.list();
    if (records.length === 0) {
      void vscode.window.showInformationMessage('Memora：当前没有可回退的文件改动');
      return;
    }
    const willDelete = records.filter((rec) => rec.beforeContent === null);
    // 有未保存编辑的文件集（模态明细 + 执行时的 overwriteDirty 白名单同源，防两处各扫一遍漂移）
    const dirtyPaths = new Set(records.filter((rec) => this.dirtyDocumentOf(rec.path) !== undefined).map((rec) => rec.path));
    const preview = records
      .slice(0, 20)
      .map((rec) => `  ${rec.relPath}${rec.beforeContent === null ? '（删除文件）' : ''}${dirtyPaths.has(rec.path) ? '（含未保存编辑）' : ''}`);
    preview.push(...(records.length > 20 ? [`  …另有 ${records.length - 20} 个文件`] : []));
    const detail = [
      `将把 ${records.length} 个文件恢复到「agent 改动之前」的内容：`,
      `· 覆盖写回：${records.length - willDelete.length} 个`,
      `· 删除文件：${willDelete.length} 个（这些文件原本为新建）`,
      `· 含未保存的编辑（会一并丢弃）：${dirtyPaths.size} 个`,
      '',
      '⚠️ 此操作不可撤销（无 git 时无法找回），且会覆盖你在 agent 改动之后对这些文件的手动编辑（含未保存的编辑）。',
      '',
      ...preview,
    ].join('\n');
    const choice = await vscode.window.showWarningMessage(
      `确认回退全部 ${records.length} 个文件的改动？`,
      { modal: true, detail },
      '确认回退',
    );
    if (choice !== '确认回退') return;
    let okCount = 0;
    const failures: string[] = [];
    for (const rec of records) {
      // 只对模态里列出的 dirty 文件放行覆盖，其余走 fail-closed 闸（防确认后新产生的编辑被吞）
      const outcome = await this.applyRestore(rec, { overwriteDirty: dirtyPaths.has(rec.path) });
      if (outcome.status === 'ok') okCount += 1;
      else failures.push(`${rec.relPath}（${outcome.status === 'failed' ? outcome.reason : '有未保存的编辑，未确认'}）`);
    }
    this.notifyChanged();
    this.lensProvider.refresh();
    if (failures.length === 0) {
      void vscode.window.showInformationMessage(`Memora：已回退 ${okCount} 个文件的改动`);
      return;
    }
    void vscode.window.showErrorMessage(
      `Memora：已回退 ${okCount} 个，${failures.length} 个失败 —— ${failures.join('；')}`,
    );
  }

  /**
   * 「有未保存编辑」的模态确认（**回退 / 拒绝此处共用**）
   *
   * 共用的理由：「if dirty → 弹模态 → 确认则带 `overwriteDirty` 重试」这段若各写一份必漂移
   * ——一处加了提示、另一处没有 ⇒ 用户在一个入口被明确告知、在另一个入口被静默覆盖。
   * 差异只在文案（动作不同），机制同一处。
   */
  private async confirmOverwriteDirty(
    rec: FileChangeRecord,
    detail: string,
    confirmLabel: string,
  ): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Memora：${rec.relPath} 有未保存的编辑`,
      { modal: true, detail },
      confirmLabel,
    );
    return choice === confirmLabel;
  }

  /**
   * 「恢复旧版」（单文件入口）：执行回退并给出结果提示
   *
   * 文件有未保存编辑时（`applyRestore` 返回 `dirty`）先弹**模态确认**——回退会丢弃用户
   * 缓冲区里的编辑，静默覆盖 = 吃掉用户劳动。用户取消则不动文件、保留记录。
   */
  private async restoreChange(rec: FileChangeRecord): Promise<void> {
    let outcome = await this.applyRestore(rec);
    if (outcome.status === 'dirty') {
      const ok = await this.confirmOverwriteDirty(
        rec,
        '回退会把文件恢复到「agent 改动之前」的内容，未保存的编辑将一并丢弃（无 git 时无法找回）。要保留这些编辑，请先取消、保存文件后再回退。',
        '仍然回退',
      );
      if (!ok) {
        void vscode.window.showInformationMessage(`Memora：已取消 ${rec.relPath} 的回退，未保存的编辑未动`);
        return;
      }
      outcome = await this.applyRestore(rec, { overwriteDirty: true });
    }
    if (outcome.status !== 'ok') {
      // 类型穷尽兜底：重试恒带 overwriteDirty ⇒ 'dirty' 实际不可达，如实走通用失败文案、不虚述场景
      const reason = outcome.status === 'failed' ? outcome.reason : '回退未能完成，请重试';
      void vscode.window.showErrorMessage(`Memora：恢复 ${rec.relPath} 失败（${reason}）`);
      return;
    }
    this.notifyChanged();
    this.lensProvider.refresh();
    void vscode.window.showInformationMessage(`Memora：已恢复 ${rec.relPath} 的旧内容`);
  }

  /**
   * 查找该文件「已打开且有未保存编辑」的文档
   *
   * 只查 `workspace.textDocuments`（已打开的文档），**不主动 open**——主动打开会把无关文件
   * 拉进工作区，动作面不该有副作用。未打开的文件不存在「未保存编辑」，无需防护。
   */
  private dirtyDocumentOf(absPath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (doc) => doc.uri.scheme === 'file' && doc.uri.fsPath === absPath && doc.isDirty,
    );
  }

  /**
   * 把指定内容写回文件：**不弹 UI、不碰记录生命周期**（生命周期归调用方）
   *
   * 🔴 **fail-closed 守卫**：文件有未保存编辑且未经用户明确确认 → 拒绝执行。
   * 写回会**连带丢弃用户缓冲区里未保存的编辑**（数据丢失类）。确认权在调用方的模态提示，
   * 这里是最后闸门——任何调用方漏问就吞用户劳动。
   *
   * @param content 写回的全文；`null` = 删除该文件
   */
  private async writeBack(
    rec: FileChangeRecord,
    content: string | null,
    opts: { overwriteDirty?: boolean } = {},
  ): Promise<RestoreOutcome> {
    if (!opts.overwriteDirty && this.dirtyDocumentOf(rec.path)) return { status: 'dirty' };
    const guard = this.deps.getSecurityGuard();
    if (!guard) return { status: 'failed', reason: '安全守卫未就绪' };
    try {
      // 工具名按**本次实际动作**传：动作为删除 → `delete_file`（否则是覆盖写回）。
      // 该参数只进审计事件的 `tool` 字段、不参与放行判定（判定只用黑白名单前缀），
      // 但审计留痕必须说实话——否则「删了什么」在审计里全记成 write_file。
      guard.assertPathAllowed(rec.path, content === null ? 'delete_file' : 'write_file');
    } catch (err) {
      return { status: 'failed', reason: `路径不允许恢复（${err instanceof Error ? err.message : String(err)}）` };
    }
    try {
      if (content === null) {
        rmSync(rec.path, { force: true });
      } else {
        // 覆盖写入；若文件已被删除，此写即「重建」
        atomicWriteFileSync(rec.path, content);
      }
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
    return { status: 'ok' };
  }

  /**
   * 执行单条回退（写回改动前内容 + 注销记录），**不弹任何 UI**
   *
   * 拆出无 UI 版本的原因：批量回退时不能逐个弹窗（N 个弹窗既吵又拖慢），
   * 由调用方汇总成一条结果。单个文件入口（`restoreChange`）在此之上加提示。
   */
  private async applyRestore(rec: FileChangeRecord, opts: { overwriteDirty?: boolean } = {}): Promise<RestoreOutcome> {
    const outcome = await this.writeBack(rec, rec.beforeContent, opts);
    if (outcome.status !== 'ok') return outcome;
    this.discardRecord(rec);
    this.refreshStatusBar();
    return outcome;
  }

  // ─── 块级动作（命题 B） ───

  /**
   * 「接受此处」：把该块**并入基线**（纯内存，**不写盘**）
   *
   * 推导（与 git `add -p` 同构）：基线 = 当前内容剔除**未接受**的块。
   * ⇒ 被接受的块在新 diff 里**自然消失**（高亮与按钮一并消失），其余块的行坐标不变
   *   （已在 `fileChangeDiff` 单测中钉死）⇒ 无需维护「已接受块集」、无需坐标迁移。
   * 块全部被接受 ⇒ diff 为空 ⇒ 走与文件级确认**同一收口**（注销记录），无特判。
   */
  private acceptHunk(rec: FileChangeRecord, key: string): void {
    const resolved = this.resolveHunk(rec, key);
    if (!resolved) {
      this.staleHunk(rec);
      return;
    }
    const { snapshot } = resolved;
    const pending = snapshot.hunks.filter((hunk) => hunkKey(hunk, snapshot.afterText) !== key);
    const baseline = applyHunkReverts(snapshot.afterText, pending);
    this.tracker.updateContents(rec.path, { beforeContent: baseline });
    // 只改基线、正文未变 ⇒ 缓存键（`afterText`）不变，必须手动失效，否则被接受的块仍高亮
    this.hunkCache.delete(rec.path);
    this.afterBlockAction(rec, false);
  }

  /**
   * 「拒绝此处」：把该块还原成旧内容（**写盘**），其余块保留
   *
   * 与文件级回退的唯一差别是「写回的内容」= 当前内容剔除这一块，而不是整个改动前快照。
   * 守卫链条与文件级回退**完全一致**（未保存编辑闸 / 路径守卫 / 原子写）——
   * 块级动作也是写盘动作，没有任何理由降低安全等级。
   */
  private async rejectHunk(rec: FileChangeRecord, key: string): Promise<void> {
    const resolved = this.resolveHunk(rec, key);
    if (!resolved) {
      this.staleHunk(rec);
      return;
    }
    const nextAfter = applyHunkReverts(resolved.snapshot.afterText, [resolved.hunk]);
    // 原为新建的文件、块又被全部拒绝 ⇒ 内容为空 ⇒ 语义就是「这个文件不该存在」
    const content: string | null = rec.beforeContent === null && nextAfter === '' ? null : nextAfter;
    let outcome = await this.writeBack(rec, content);
    if (outcome.status === 'dirty') {
      const ok = await this.confirmOverwriteDirty(
        rec,
        '拒绝此处改动会覆盖该文件当前内容，未保存的编辑将一并丢弃（无 git 时无法找回）。要保留这些编辑，请先取消、保存文件后再操作。',
        '仍然拒绝',
      );
      if (!ok) {
        void vscode.window.showInformationMessage(`Memora：已取消 ${rec.relPath} 的块级拒绝，未保存的编辑未动`);
        return;
      }
      outcome = await this.writeBack(rec, content, { overwriteDirty: true });
    }
    if (outcome.status !== 'ok') {
      // 类型穷尽兜底：重试恒带 overwriteDirty ⇒ 'dirty' 实际不可达，如实走通用文案、不虚述场景
      const reason = outcome.status === 'failed' ? outcome.reason : '拒绝未能完成，请重试';
      void vscode.window.showErrorMessage(`Memora：拒绝 ${rec.relPath} 的该处改动失败（${reason}）`);
      return;
    }
    this.tracker.updateContents(rec.path, { afterContent: content });
    this.afterBlockAction(rec, true);
  }

  /**
   * 块指纹失效的统一处置：**fail-closed**
   *
   * 渲染 → 点击之间内容变了（并行写同一文件 / 用户手改）时指纹对不上。此时唯一正确的动作是
   * 「不动盘 + 留痕 + 刷新按钮」，绝不按下标猜——猜错会回退掉用户没要求回退的内容。
   */
  private staleHunk(rec: FileChangeRecord): void {
    this.deps.log(`[fileChange] 块指纹已失效（内容已变），已跳过并刷新按钮：${rec.relPath}`);
    this.lensProvider.refresh();
  }

  /**
   * 块级动作之后的统一收口
   *
   * ① 重算块；② 块已处理完 ⇒ 与文件级确认**同一收口**（注销记录）；
   * ③ 还剩块 ⇒ 重画——「拒绝」改了盘要重载文档再画，「接受」只改基线故只重画装饰。
   *
   * ⚠️ **「拒绝」必须等文档重载落地后再刷按钮**（2026-09-27 真机纠因）：CodeLens 的落点要用
   * **文档行数**参与 clamp，而「拒绝」是宿主直写盘、文档缓存滞后 ⇒ 若立刻 `refresh()`，
   * VS Code 会拿着旧文档去问新块，按钮落到错的行上。故把刷新挂到 `revealChange` 之后。
   *
   * @param reloadDoc 本次动作是否改了磁盘内容（拒绝 = true；接受 = false）
   */
  private afterBlockAction(rec: FileChangeRecord, reloadDoc: boolean): void {
    const latest = this.tracker.get(rec.path);
    const settled = (): void => {
      this.refreshStatusBar();
      this.lensProvider.refresh();
      this.notifyChanged();
    };
    if (!latest) {
      settled();
      return;
    }
    if (this.snapshotFor(latest).hunks.length === 0) {
      // 全部块都处理完了 ⇒ 与文件级确认同一个收口，不另设「块级确认」通道
      this.discardRecord(latest);
      settled();
      return;
    }
    if (reloadDoc) {
      void this.revealChange(latest).finally(settled);
      return;
    }
    this.reapplyDecorations();
    settled();
  }

  /** 改动通知（带按钮）：确认改动 / 恢复旧版 / 查看对比 / 全部确认 */
  private notifyChange(rec: FileChangeRecord): void {
    const count = this.tracker.size();
    const message = count > 1
      ? `Memora：本次已改动 ${count} 个文件（最新：${rec.relPath}）`
      : `Memora：已修改 ${rec.relPath}（改动处已在文件中高亮）`;
    void vscode.window
      .showInformationMessage(message, '确认改动', '恢复旧版', '查看对比', '全部确认')
      .then((choice) => {
        // 用最新记录执行（通知展示期间该文件可能又被改过）
        const latest = this.tracker.get(rec.path) ?? rec;
        if (choice === '确认改动') this.confirmChange(latest);
        else if (choice === '恢复旧版') void this.restoreChange(latest);
        else if (choice === '查看对比') void this.openCompare(latest);
        else if (choice === '全部确认') this.confirmAll();
      });
  }

  /** 状态栏入口：QuickPick 列出「全部确认」+ 全部未确认改动 → 选文件 → 选动作 */
  private async showChangeList(): Promise<void> {
    const records = this.tracker.list();
    if (records.length === 0) {
      void vscode.window.showInformationMessage('Memora：当前没有未确认的文件改动');
      return;
    }
    const items: ChangePickItem[] = [
      { label: `$(check-all) 全部确认（${records.length} 个文件）`, all: true },
      ...records.map((record) => ({ label: `$(file) ${record.relPath}`, description: describeChange(record), record })),
    ];
    const picked = await vscode.window.showQuickPick<ChangePickItem>(items, {
      title: '本次文件改动',
      placeHolder: '选择「全部确认」或要处理的文件',
    });
    if (!picked) return;
    if (picked.all || !picked.record) {
      this.confirmAll();
      return;
    }
    const record = picked.record;
    const action = await vscode.window.showQuickPick<ActionPickItem>(
      [
        { label: '$(diff) 打开对比', action: 'compare' },
        { label: '$(discard) 恢复旧版', action: 'restore' },
        { label: '$(check) 确认改动', action: 'confirm' },
      ],
      { title: record.relPath, placeHolder: '选择操作' },
    );
    if (!action) return;
    if (action.action === 'compare') await this.openCompare(record);
    else if (action.action === 'restore') await this.restoreChange(record);
    else this.confirmChange(record);
  }

  private refreshStatusBar(): void {
    if (!this.statusBar) return;
    const count = this.tracker.size();
    if (count === 0) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = `$(diff) Memora: ${count} 个未确认改动`;
    this.statusBar.tooltip = '点击处理：全部确认 / 打开对比 / 恢复旧版';
    // 黄色警示底：把「有未确认改动」做成一眼可见的常驻入口。
    // 真机反馈「没有确认/回退的按钮」的根因之一是入口不够显眼——通知会被用户划走，状态栏不会。
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.statusBar.show();
  }

  /** 释放装饰类型 / CodeLens / 事件（扩展停用 / 面板销毁） */
  dispose(): void {
    for (const decorationType of this.decorations.values()) decorationType.dispose();
    this.decorations.clear();
    this.virtualContents.clear();
    this.hunkCache.clear();
    this.renderSeq.clear();
    this.lensProvider.dispose();
    this.changeEmitter.dispose();
  }
}
