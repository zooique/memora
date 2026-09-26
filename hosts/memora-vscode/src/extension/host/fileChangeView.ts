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
 *   ④ 每个 hunk 上方 **CodeLens 按钮**「确认 / 回退」（VS Code 会把同一行的多个 CodeLens 并排渲染，
 *      这就是 Trae「Y Accept / N Reject」的纯扩展等价形态；`CodeLens.command` 只支持单命令，
 *      故多按钮 = 同 range 多个 CodeLens）。
 *
 * `vscode.diff` 侧对比**降级为按需**（CodeLens「全部确认」入口之外的「对比」按钮 / 状态栏 QuickPick
 * / 改动通知），不再是自动路径——用户诉求是「不用专门打开 diff 对比」。
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
import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { atomicWriteFileSync } from './atomicWriteSync.js';
import {
  computeFileDiff,
  hunkAnchorLine,
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

/**
 * 对比预览的字符上限（超过则只做整文档高亮、跳过虚拟文档 diff）。
 *
 * 值取自内核 `src/security/pathGuard.ts` 的 `MAX_DIFF_CONTENT_LENGTH = 10240`
 * （注释「防大文件撑爆 IPC 传输和 UI 渲染」——与宿主 UI 场景同因）。该内核常量为
 * **模块私有、未导出**，宿主无法 `import`；为守住「零内核改动」，此处**并列定义同值常量**，
 * 属项目认可的「同模式重复」（非 SSOT 违例）。若内核后续导出该常量，改为 import 引用。
 */
const DIFF_PREVIEW_MAX_CHARS = 10240;

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
 * CodeLens 内部命令 id（**不进 package.json#contributes.commands**）
 *
 * 它们需要「文件绝对路径」参数，只应由 CodeLens 携带调用；暴露到命令面板会得到
 * 无参调用而静默失败。故只 `registerCommand`，不贡献声明。
 */
export const CONFIRM_INLINE_COMMAND = 'memora.fileChange.confirmInline';
export const RESTORE_INLINE_COMMAND = 'memora.fileChange.restoreInline';

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
 * CodeLens provider：在文件**顶部与底部**各放一组按钮（Trae 式行内操作）
 *
 * 为何不再挂在每个 hunk 上（2026-09-26 真机修正）：CodeLens 渲染在**所在行的上方**，
 * 挂在 hunk 首行时按钮会紧贴在**上一个 hunk 末尾**之下，视觉上像属于上一段——真机上用户
 * 因此把「回退本文件」误读成「回退上一段」，并怀疑「新增的内容没有回退」。而动作粒度本就是
 * **整个文件**（不是单处），逐 hunk 摆按钮只会放大「一处一个按钮」的错觉。
 * ⇒ 收敛为两个位置：顶部（就近可见）与底部（长文件不必翻回顶部）。
 *
 * hunk 数据从注入的取值函数拿（复用 `FileChangeView` 的缓存），保证与装饰同源——
 * 两处各算一遍 diff 会漂移，属 SSOT 违例。
 */
class FileChangeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly hunksOf: (absPath: string) => DiffHunk[] | undefined,
    /** 未确认改动的文件总数（「全部」按钮据此显示影响范围） */
    private readonly totalFilesOf: () => number,
  ) {}

  get onDidChangeCodeLenses(): vscode.Event<void> {
    return this.emitter.event;
  }

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const absPath = document.uri.fsPath;
    const hunks = this.hunksOf(absPath);
    if (!hunks || hunks.length === 0) return [];
    const total = this.totalFilesOf();
    // 顶部 = 第 0 行；底部 = 末行（CodeLens 渲染在所在行**上方**，故末行即「文件末尾」）
    const lastLine = Math.max(document.lineCount - 1, 0);
    return [
      ...this.buttonGroup(safeLineRange(document, 0), absPath, total),
      ...this.buttonGroup(safeLineRange(document, lastLine), absPath, total),
    ];
  }

  /**
   * 一组四按钮：本文件（两颗） + 全部（两颗）
   *
   * 「全部回退」是**破坏性**动作（写盘、不可撤销），但其实现自带模态二次确认
   * （`FileChangeView.revertAll`），故命令面板 / 文件内入口都安全；
   * 「全部确认」是纯内存清理，幂等零风险。
   */
  private buttonGroup(range: vscode.Range, absPath: string, total: number): vscode.CodeLens[] {
    return [
      new vscode.CodeLens(range, {
        title: '$(check) 确认本文件改动',
        command: CONFIRM_INLINE_COMMAND,
        arguments: [absPath],
      }),
      new vscode.CodeLens(range, {
        title: '$(discard) 回退本文件改动',
        command: RESTORE_INLINE_COMMAND,
        arguments: [absPath],
      }),
      new vscode.CodeLens(range, {
        title: `$(check-all) 全部确认（${total} 个文件）`,
        command: CONFIRM_ALL_FILE_CHANGES_COMMAND,
      }),
      new vscode.CodeLens(range, {
        title: `$(discard) 全部回退（${total} 个文件）`,
        command: REVERT_ALL_FILE_CHANGES_COMMAND,
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
   */
  private readonly hunkCache = new Map<string, { after: string; hunks: DiffHunk[] }>();
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
    this.lensProvider = new FileChangeCodeLensProvider(
      (absPath) => this.hunksOfPath(absPath),
      () => this.tracker.size(),
    );
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
    const confirmInline = vscode.commands.registerCommand(CONFIRM_INLINE_COMMAND, (arg: unknown) => {
      this.withRecord(arg, (rec) => this.confirmChange(rec));
    });
    const restoreInline = vscode.commands.registerCommand(RESTORE_INLINE_COMMAND, (arg: unknown) => {
      this.withRecord(arg, (rec) => void this.restoreChange(rec));
    });
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = REVIEW_FILE_CHANGES_COMMAND;
    this.statusBar.name = 'Memora 文件改动';
    // 装饰绑定在**编辑器实例**上，切走再切回不会自动恢复（CodeLens 走 provider 模式则不受影响）
    // ⇒ 可见编辑器集合变化时必须主动补齐，否则「切个文件回来，高亮全没、只剩按钮」
    const editorWatcher = vscode.window.onDidChangeVisibleTextEditors(() => this.reapplyDecorations());
    context.subscriptions.push(
      provider,
      lensRegistration,
      reviewCommand,
      confirmAllCommand,
      revertAllCommand,
      confirmInline,
      restoreInline,
      editorWatcher,
      this.statusBar,
      {
        dispose: (): void => this.dispose(),
      },
    );
    this.refreshStatusBar();
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
   */
  private notifyChanged(): void {
    this.changeEmitter.fire(this.snapshotFiles());
  }

  /** 命令参数守卫：CodeLens 携带的是文件绝对路径字符串，非法参数静默忽略并留痕 */
  private withRecord(arg: unknown, run: (rec: FileChangeRecord) => void): void {
    if (typeof arg !== 'string') {
      this.deps.log('[fileChange] 命令参数非法（期望文件绝对路径字符串），已忽略');
      return;
    }
    const rec = this.tracker.get(arg);
    if (!rec) return;
    run(rec);
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
      const hunks = this.hunksFor(rec);
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

  /** 取（并缓存）某条记录的改动块；超限降级时留痕。写后内容一变即重算（见 `hunkCache` 注释） */
  private hunksFor(rec: FileChangeRecord): DiffHunk[] {
    const after = rec.afterContent ?? '';
    const cached = this.hunkCache.get(rec.path);
    if (cached && cached.after === after) return cached.hunks;
    const diff = computeFileDiff(rec.beforeContent ?? '', after);
    if (diff.degraded) {
      this.deps.log(`[fileChange] ${rec.relPath} 改动过大，已降级为整体高亮（逐行对照跳过）`);
    }
    this.hunkCache.set(rec.path, { after, hunks: diff.hunks });
    return diff.hunks;
  }

  /** CodeLens 的数据源：按路径取当前记录的改动块（文档打开顺序无关，可独立计算） */
  private hunksOfPath(absPath: string): DiffHunk[] | undefined {
    const rec = this.tracker.get(absPath);
    if (!rec) return undefined;
    return this.hunksFor(rec);
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

  /** 打开对比：左 = 旧内容虚拟文档，右 = 真实文件（旧内容仅展示、不落盘） */
  private async openCompare(rec: FileChangeRecord): Promise<void> {
    if (rec.afterContent !== null && Math.max((rec.beforeContent ?? '').length, rec.afterContent.length) > DIFF_PREVIEW_MAX_CHARS) {
      void vscode.window.showInformationMessage(`Memora：${rec.relPath} 改动过大，已跳过对比预览（可「回退」）`);
      return;
    }
    const fileName = basename(rec.path);
    const leftUri = this.virtualUriFor(rec.path, fileName);
    this.virtualContents.set(leftUri.toString(), rec.beforeContent ?? '');
    let rightUri: vscode.Uri;
    if (rec.afterContent === null || !existsSync(rec.path)) {
      // 已删除：右侧给空虚拟文档，语义 = 「旧内容 vs 空」
      rightUri = this.virtualUriFor(this.rightSeed(rec.path), fileName);
      this.virtualContents.set(rightUri.toString(), '');
    } else {
      rightUri = vscode.Uri.file(rec.path);
    }
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${fileName} — 本次改动对比`);
  }

  /** 虚拟 URI（键 = seed 的 hash；尾部保留文件名与扩展名供语言推断） */
  private virtualUriFor(seed: string, fileName: string): vscode.Uri {
    const hash = createHash('sha1').update(seed).digest('hex').slice(0, 12);
    return vscode.Uri.from({ scheme: VIRTUAL_SCHEME, path: `/${hash}/${fileName}` });
  }

  /** 右侧空虚拟文档的 seed（与左侧区分，避免同 URI 覆盖） */
  private rightSeed(absPath: string): string {
    return `${absPath}#right`;
  }

  /** 精确释放某条记录占用的虚拟文档内容（**不误伤其它记录**的对比视图） */
  private releaseVirtual(rec: FileChangeRecord): void {
    const fileName = basename(rec.path);
    this.virtualContents.delete(this.virtualUriFor(rec.path, fileName).toString());
    this.virtualContents.delete(this.virtualUriFor(this.rightSeed(rec.path), fileName).toString());
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
   */
  private async revertAll(): Promise<void> {
    const records = this.tracker.list();
    if (records.length === 0) {
      void vscode.window.showInformationMessage('Memora：当前没有可回退的文件改动');
      return;
    }
    const willDelete = records.filter((rec) => rec.beforeContent === null);
    const preview = records
      .slice(0, 20)
      .map((rec) => `  ${rec.relPath}${rec.beforeContent === null ? '（删除文件）' : ''}`);
    preview.push(...(records.length > 20 ? [`  …另有 ${records.length - 20} 个文件`] : []));
    const detail = [
      `将把 ${records.length} 个文件恢复到「agent 改动之前」的内容：`,
      `· 覆盖写回：${records.length - willDelete.length} 个`,
      `· 删除文件：${willDelete.length} 个（这些文件原本为新建）`,
      '',
      '⚠️ 此操作不可撤销（无 git 时无法找回），且会覆盖你在 agent 改动之后对这些文件的手动编辑。',
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
      const reason = await this.applyRestore(rec);
      if (reason === null) okCount += 1;
      else failures.push(`${rec.relPath}（${reason}）`);
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

  /** 「恢复旧版」（单文件入口）：执行回退并给出结果提示 */
  private async restoreChange(rec: FileChangeRecord): Promise<void> {
    const reason = await this.applyRestore(rec);
    if (reason !== null) {
      void vscode.window.showErrorMessage(`Memora：恢复 ${rec.relPath} 失败（${reason}）`);
      return;
    }
    this.notifyChanged();
    this.lensProvider.refresh();
    void vscode.window.showInformationMessage(`Memora：已恢复 ${rec.relPath} 的旧内容`);
  }

  /**
   * 执行单条回退，**不弹任何 UI**（返回 `null` = 成功，否则为失败原因）
   *
   * 拆出无 UI 版本的原因：批量回退时不能逐个弹窗（N 个弹窗既吵又拖慢），
   * 由调用方汇总成一条结果。单个文件入口（`restoreChange`）在此之上加提示。
   */
  private async applyRestore(rec: FileChangeRecord): Promise<string | null> {
    const guard = this.deps.getSecurityGuard();
    if (!guard) return '安全守卫未就绪';
    try {
      guard.assertPathAllowed(rec.path, 'write_file');
    } catch (err) {
      return `路径不允许恢复（${err instanceof Error ? err.message : String(err)}）`;
    }
    try {
      if (rec.beforeContent === null) {
        // 原为新建 → 恢复 = 删除该文件
        rmSync(rec.path, { force: true });
      } else {
        // 覆盖写入；若文件已被删除，此写即「重建」
        atomicWriteFileSync(rec.path, rec.beforeContent);
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    this.discardRecord(rec);
    this.refreshStatusBar();
    return null;
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
