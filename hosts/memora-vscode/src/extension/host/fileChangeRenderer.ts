/**
 * 文件改动可视化 · 渲染呈现域（块快照缓存 + 内联装饰 + 悬停 + 渲染并发守卫）
 *
 * 从 `fileChangeView.ts` 提取（HOST-SPLIT-1 P2 首刀，方案见
 * `tasks/方案-HOST-SPLIT-1-fileChangeView渲染域提取-20261021.md`）。
 *
 * 域职责三条：
 *   ① **块快照同源消费**（`hunkCache`）：装饰与 CodeLens、块级动作寻址读**同一份**计算产物
 *      ——两处各算一遍 diff 必漂移（SSOT）。view 侧经 `snapshotOfPath` / `snapshotFor` /
 *      `resolveHunk` 查询，本域是缓存唯一属主。
 *   ② **内联装饰生命周期**（`decorations`）：装饰项绑定在**编辑器实例**上，切走再切回不会
 *      自动恢复 ⇒ 可见编辑器变化时必须主动 `reapplyDecorations` 补齐。
 *   ③ **渲染并发守卫**（`renderSeq`）：一个 step 内模型可能并行多次写同一文件，先发起的
 *      渲染可能后完成覆盖最新装饰 ⇒ 每个文件只允许序号最新的那次落地。
 *
 * 外部依赖仅两个（注入）：`FileChangeTracker` 实例（构造后不变）与 `log` 窄函数
 * （结构化兼容 `FileChangeViewDeps.log`，刻意不 import 该类型 = 与 view 零耦合、无环）。
 *
 * ⚠️ 装饰选项函数（`highlightOptions` / `removedHighlightOptions`）**必须惰性构建，
 * 勿改回模块顶层常量**（`vscode.OverviewRulerLane` 是运行时枚举，顶层求值会让最小 mock
 * 环境 import 即抛错），理由详见两函数各自的 JSDoc。
 *
 * @module fileChangeRenderer
 */

import * as vscode from 'vscode';
import {
  computeFileDiff,
  hunkAnchorLine,
  hunkKey,
  isRemovedOnly,
  type DiffHunk,
} from './fileChangeDiff.js';
import type { FileChangeRecord, FileChangeTracker } from './fileChangeTracker.js';

/** hoverMessage 里最多展示的旧行数（超出以「…」收尾，防超长内容撑爆悬停卡片） */
const HOVER_MAX_LINES = 30;

/**
 * 改动行高亮装饰（字面高对比色，不依赖主题色）
 *
 * 绿色系（与「新增/修改」直觉一致）+ 左侧竖条 border，明暗主题下都清晰可见；
 * `isWholeLine` 使整行铺满。主题色 `diffEditor.insertedTextBackground` 在部分主题下几乎不可见，故用字面高对比色。
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

/**
 * 纯删除块的「删除位置」标记（红色系）
 *
 * 纯删除块在新文件中**不覆盖任何行**，装饰只能落在 `hunkAnchorLine` 给出的删除点锚行——
 * 那一行本身是**未变的其他内容**，铺明显红底会让用户误读成「该行被删」。因此：
 * 主信号 = 3px 红竖条 + 概览标尺红点；行底只给极淡一层（远淡于绿色 0.18）。
 * 纯删除块若复用上面的绿色装饰 =「删除点被染成新增色」的语义错位，本装饰收口之。
 * 颜色对位 GitHub diff 的删除红（248, 81, 73）。同样**必须惰性构建**（理由同上）。
 */
let removedHighlightOptionsCache: vscode.DecorationRenderOptions | undefined;
function removedHighlightOptions(): vscode.DecorationRenderOptions {
  removedHighlightOptionsCache ??= {
    isWholeLine: true,
    backgroundColor: 'rgba(248, 81, 73, 0.10)',
    borderColor: 'rgba(248, 81, 73, 0.85)',
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    overviewRulerColor: 'rgba(248, 81, 73, 0.85)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  };
  return removedHighlightOptionsCache;
}

/** 同一文件的成对装饰类型：新增/修改走绿（added），纯删除块的删除位置走红（removed） */
interface DecorationPair {
  added: vscode.TextEditorDecorationType;
  removed: vscode.TextEditorDecorationType;
}

/**
 * 取一行可安全用于装饰/CodeLens 的 range
 *
 * 空行（含文件末尾的空行）的 `TextLine.range` 是**空 range**，而装饰与 CodeLens 都要求非空
 * ——直接传会抛错。此处对空行扩到「下一行行首」，末行空行时越界由 VS Code clamp。
 *
 * 导出给 view 侧的 CodeLens 落点计算消费（view → 本模块单向依赖，反向 import 即成环）。
 */
export function safeLineRange(document: vscode.TextDocument, line: number): vscode.Range {
  const last = Math.max(document.lineCount - 1, 0);
  const target = Math.min(Math.max(line, 0), last);
  const textLine = document.lineAt(target);
  if (!textLine.range.isEmpty) return textLine.range;
  return new vscode.Range(target, 0, target + 1, 0);
}

/**
 * 一次块计算的产物：**块列表 + 算它们时用的写后全文**
 *
 * 为什么要带上 `afterText`：`DiffHunk` 只有坐标与被删的旧行，**没有**块的新行内容，
 * 而块寻址指纹 `hunkKey` 需要它。指纹必须由**同一次计算**产出并在渲染/点击间传递——
 * 渲染时算一份、点击时再算一份 = 两份并列，必漂移（SSOT 违例）。
 */
export interface HunkSnapshot {
  hunks: DiffHunk[];
  /** 算这些块时用的写后全文（`''` = 文件已删除 / 为空） */
  afterText: string;
}

/**
 * 渲染呈现域容器：块快照缓存 + 内联装饰 + 悬停 + 渲染并发守卫
 *
 * 方法名自 `fileChangeView` **零改名**原样搬迁（`this.reconcile()` → `this._render.reconcile()`
 * 纯路径变化）。`invalidateSnapshot` / `release` / `dispose` 是跨文件访问的最小新增接口
 * （字段搬走后的必然封装，非顺便优化）——两方法**不得合并**：`noteToolResult` 只失效快照、
 * **不动** `renderSeq`（在途渲染序号另有语义），合并即行为变更。
 */
export class FileChangeRenderer {
  /**
   * 每条记录的逐行改动块缓存（渲染与 CodeLens **同源**消费，避免两处各算一遍）
   *
   * 值里带上「算这份 hunk 时用的写后内容」——并发写同一文件时缓存与 tracker 记录可能
   * 不同代，只按 path 命中会拿旧 hunk 去渲染（「部分改动没高亮」的成因之一）。
   *
   * ⚠️ **改基线（`beforeContent`）也必须 `delete` 本缓存**：缓存的命中键是 `afterText`，
   * 只改基线不改正文 ⇒ 键不变、却拿到旧块（被接受的块仍高亮）。改正文则键自然失效，无需额外处理。
   */
  private readonly hunkCache = new Map<string, HunkSnapshot>();
  /** 每条记录的高亮装饰类型（确认/恢复/重渲染时 dispose） */
  private readonly decorations = new Map<string, DecorationPair>();
  /**
   * 每个文件的渲染序号
   *
   * 一个 step 里模型可能**并行多次写同一文件**（实测 insert + append 同 step 发出），
   * `noteToolResult` 会连着触发多次渲染；`openTextDocument` 是异步的，先发起的渲染可能
   * **后完成**并覆盖最新装饰 ⇒ 每个文件只允许**序号最新**的那次渲染落地。
   */
  private readonly renderSeq = new Map<string, number>();

  constructor(
    private readonly tracker: FileChangeTracker,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * 打开真实文件 + 内联呈现（**不自动弹 diff 窗口**；对比视图改为按需）
   *
   * 并发安全：一个 step 内模型可能**并行多次写同一文件**
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
  async revealChange(rec: FileChangeRecord): Promise<void> {
    if (rec.afterContent === null) return; // 已删除：无文件可打开（可在入口中「回退本文件改动」）
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
      // 不再静默：打开/装饰失败必须留痕（「打开了但无高亮」会因此无诊断线索）
      this.log(
        `[fileChange] 打开/渲染失败 ${rec.relPath}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 本文件的渲染序号是否仍是最新（并发写同一文件时只让最后发起的那次渲染落地） */
  private isLatestRender(absPath: string, seq: number): boolean {
    return this.renderSeq.get(absPath) === seq;
  }

  /**
   * 内联呈现：改动行高亮 + 悬停看旧内容 +（可选）视口定位
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
        this.log(`[fileChange] 文档已被改动或重载失败（高亮范围可能错位）${rec.relPath}`);
      }
      const hunks = this.snapshotFor(rec).hunks;
      if (hunks.length === 0) return;
      const pair: DecorationPair = {
        added: vscode.window.createTextEditorDecorationType(highlightOptions()),
        removed: vscode.window.createTextEditorDecorationType(removedHighlightOptions()),
      };
      this.decorations.set(rec.path, pair);

      const { added, removed } = this.buildDecorationItems(doc, hunks);
      const targets = vscode.window.visibleTextEditors.filter(
        (editor) => editor.document.uri.toString() === doc.uri.toString(),
      );
      // 只对**非空**的一侧调 setDecorations：空数组调用是纯噪音，还会让「有几批装饰」的
      // 断言被迫去数空批。曾经挂载的装饰随旧 type 的 dispose（上方 clearDecoration）一并清除，
      // 不会出现「这轮 removed 为空但上一轮的红色残留还挂着」。
      for (const editor of targets) {
        if (added.length > 0) editor.setDecorations(pair.added, added);
        if (removed.length > 0) editor.setDecorations(pair.removed, removed);
      }

      if (!reveal || targets.length === 0) return;
      const anchor = this.anchorRange(doc, hunks);
      if (!anchor) return;
      const target =
        targets.find((editor) => editor === vscode.window.activeTextEditor) ?? targets[0];
      target.revealRange(anchor, vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      this.log(
        `[fileChange] 装饰应用失败 ${rec.relPath}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 逐行装饰项，按语义拆两侧：**新增/修改**行走绿色（added），**纯删除块**的删除位置
   * 行红色（removed）。两侧必须用**不同的 decorationType**——颜色语义不能混：
   * 绿底行 = 这行是新内容；红竖条行 = 这行没变、它前面删了东西（旧内容在悬停里）。
   */
  private buildDecorationItems(
    doc: vscode.TextDocument,
    hunks: DiffHunk[],
  ): { added: vscode.DecorationOptions[]; removed: vscode.DecorationOptions[] } {
    const added: vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];
    for (const hunk of hunks) {
      const first = hunkAnchorLine(hunk, doc.lineCount);
      if (isRemovedOnly(hunk)) {
        // 纯删除：新文件中已无对应行 → 把旧内容挂到删除位置的锚点行
        removed.push(this.decorationFor(doc, first, hunk));
        continue;
      }
      for (let line = hunk.startLine; line <= hunk.endLine; line += 1) {
        added.push(
          line === hunk.startLine
            ? this.decorationFor(doc, line, hunk)
            : { range: safeLineRange(doc, line) },
        );
      }
    }
    return { added, removed };
  }

  /** 首个改动块的定位锚点（视口滚到这里） */
  private anchorRange(doc: vscode.TextDocument, hunks: DiffHunk[]): vscode.Range | undefined {
    const first = hunks[0];
    return first ? safeLineRange(doc, hunkAnchorLine(first, doc.lineCount)) : undefined;
  }

  /**
   * 编辑器可见集变化后补齐装饰（切文件 / 切回 / 分屏）
   *
   * 触发场景：切换查看其他文件再切回源文件，**高亮全部消失、只剩 CodeLens 按钮**。
   * 根因 = 装饰项绑在编辑器实例上，VS Code 不会在编辑器重新可见时替你恢复；而 CodeLens 走
   * provider 模式（`provideCodeLenses` 由 VS Code 主动调用）不受影响 ⇒ 只有高亮丢了。
   * 同一个文件可能同时出现在多个编辑器里，故按路径去重后逐个补齐。
   */
  reapplyDecorations(): void {
    const seen = new Set<string>();
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri;
      if (uri.scheme !== 'file' || seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      const rec = this.tracker.get(uri.fsPath);
      if (rec) this.renderInline(rec, editor.document, false);
    }
  }

  /**
   * 带悬停旧内容的单行装饰
   *
   * **只有悬停、不挂行尾常驻预览**：行尾那行红色「⟵ 原: …」与 hover
   * 说的是同一件事，却长期占着版面 = 视觉噪音；对照需求交给「查看对比」的左右分栏 diff。
   */
  private decorationFor(
    doc: vscode.TextDocument,
    line: number,
    hunk: DiffHunk,
  ): vscode.DecorationOptions {
    return { range: safeLineRange(doc, line), hoverMessage: this.oldContentHover(hunk) };
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
  snapshotFor(rec: FileChangeRecord): HunkSnapshot {
    const afterText = rec.afterContent ?? '';
    const cached = this.hunkCache.get(rec.path);
    if (cached && cached.afterText === afterText) return cached;
    const diff = computeFileDiff(rec.beforeContent ?? '', afterText);
    if (diff.degraded) {
      this.log(`[fileChange] ${rec.relPath} 改动过大，已降级为整体高亮（逐行对照跳过）`);
    }
    const snapshot: HunkSnapshot = { hunks: diff.hunks, afterText };
    this.hunkCache.set(rec.path, snapshot);
    return snapshot;
  }

  /** CodeLens 的数据源：按路径取当前记录的块快照（文档打开顺序无关，可独立计算） */
  snapshotOfPath(absPath: string): HunkSnapshot | undefined {
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
  resolveHunk(
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
   * `hunkCache` 与 `decorations` 会残留。功能上无害（快照查询先经 `tracker.get` 判空，
   * 陈旧缓存永不被消费），但内存与已废弃的装饰不回收。淘汰的唯一发生点是 `noteToolResult`
   * （`evictOverflow` 只在那里被调），故只在该处对齐一次，不额外挂全局监听。
   */
  reconcile(): void {
    const alive = new Set(this.tracker.list().map((rec) => rec.path));
    for (const key of [...this.hunkCache.keys()]) {
      if (!alive.has(key)) this.hunkCache.delete(key);
    }
    for (const key of [...this.decorations.keys()]) {
      if (!alive.has(key)) this.clearDecoration(key);
    }
  }

  private clearDecoration(absPath: string): void {
    const pair = this.decorations.get(absPath);
    if (pair) {
      pair.added.dispose();
      pair.removed.dispose();
      this.decorations.delete(absPath);
    }
  }

  /**
   * 失效某条记录的块快照缓存（**不动** `renderSeq`）
   *
   * 内容已变（写入 / 外部改动 / 改基线）时调用：缓存的改动块与 CodeLens 全部失效，必须重算
   * （否则装饰停在旧范围）。刻意与 `release` 分开——`noteToolResult` 只需失效快照，
   * 在途渲染序号另有语义，合并即行为变更。
   */
  invalidateSnapshot(absPath: string): void {
    this.hunkCache.delete(absPath);
  }

  /**
   * 注销一条记录占用的**全部渲染资源**：装饰 + 快照缓存 + 渲染序号
   *
   * 记录已确认/回退 ⇒ 作废在途渲染（否则可能给已确认的文件重新画上高亮）。
   * 虚拟文档内容（`virtualContents`）归 view 的对比域，不在本域清理面内。
   */
  release(absPath: string): void {
    this.clearDecoration(absPath);
    this.hunkCache.delete(absPath);
    this.renderSeq.delete(absPath);
  }

  /** 释放装饰类型与三个缓存 Map（扩展停用 / 面板销毁时由 view 委托调用） */
  dispose(): void {
    for (const pair of this.decorations.values()) {
      pair.added.dispose();
      pair.removed.dispose();
    }
    this.decorations.clear();
    this.hunkCache.clear();
    this.renderSeq.clear();
  }
}
