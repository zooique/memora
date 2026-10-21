/**
 * 活动文件跟踪域（HOST-SPLIT-1 第 1 刀 · 自 `webview/panels/chatPanel.ts` 迁出）
 *
 * **迁出动因**：chatPanel 类体 4211 行 / 38 字段 / 100 方法，超
 * `progressive-refactor-rules.md §1` 硬阈值（字段 ≥15）。本域是第一个按
 * 「依赖注入式提取」搬出的领域容器，作为后续各刀的模式验证。
 *
 * **边界**：本域管「当前打开的文件会不会进本轮上下文」——取快照（廉价事实）、
 * 判注入（唯一判据）、产投影（chip 显示）、注册显示订阅。**不**管信封构造
 * （归 `webview/helpers/docContext.ts`）、**不**管诊断采集（归
 * `extension/host/problemsCollector.ts`）。
 *
 * **方法名零改名**：调用点从 `this.resolveActiveFile(true)` 变为
 * `this._activeFile.resolveActiveFile(true)`，纯路径变化、零语义变化。
 */
import * as vscode from 'vscode';
import type { ActiveFileProjection, ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 文档正文注入上限（字符，约 3~4k token，防大文档爆上下文）——仅脏/未命名/工作区外文件走注入 */
const MAX_DOC_CONTEXT_CHARS = 12000;

/**
 * 活动编辑器**廉价快照**：判「注入正文」还是「只给指针」所需的全部事实
 *
 * ⚠️ **刻意不含正文**：显示订阅（换文件 / 编辑 / 保存）每次击键都取本快照，若把正文
 * （`getText()` 全篇 + 截断）并进来，就成「每敲一个字全量读一遍文档」——那是修复
 * 「缓存撒谎」时自己引入的效率回退。正文只在**真要注入**时经 {@link readDocBody} 惰性读取。
 */
export type DocContextSnapshot = {
  /** 文件名（注入正文时的首行，也用作 chip 标签的回退显示） */
  fileName: string;
  /** 有未保存修改 ⇒ buffer 才是真相，磁盘不是 */
  isDirty: boolean;
  /** 未命名文档 ⇒ 无磁盘版本可读 */
  isUntitled: boolean;
  /** 工作区相对路径（未命名 / 落在工作区外时 undefined ⇒ 指针不可用） */
  relativePath?: string;
};

/** 绝对路径判定（跨平台）：Windows 盘符 / UNC / POSIX 根 */
function isAbsolutePathLike(p: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(p);
}

/**
 * 读取活动编辑器**廉价快照**（**发送时实时取，不缓存；不含正文**）
 *
 * 为什么不缓存：脏态是高频变化的量，而 `onDidChangeActiveTextEditor` 只覆盖「切文件」，
 * 不覆盖「同一文件被编辑」——缓存会让判据撒谎（打开时干净、改完仍判干净 ⇒ 不注入旧版）。
 *
 * ⚠️ 本函数**不读正文**：它被显示订阅按**每次击键**调用（见
 * {@link ActiveFileTracker.pushActiveFile}），在此 `getText()` 等于每敲一个字全量读一遍文档。
 * 正文只在确定要注入时经 {@link readDocBody} 取。
 *
 * @param editor 当前活动编辑器（无则返回 undefined ⇒ 本轮无文档上下文）
 */
export function snapshotDocContext(
  editor: vscode.TextEditor | undefined,
): DocContextSnapshot | undefined {
  if (!editor) return undefined;
  const doc = editor.document;
  // 未命名文档没有磁盘身份；工作区外文件 asRelativePath 会回退成绝对路径形态，
  // 对「模型 read_file」与「宿主 open_ref 定位」都不可用 ⇒ 一律视为无相对路径。
  const rel = doc.isUntitled ? undefined : vscode.workspace.asRelativePath(doc.uri);
  return {
    fileName: doc.fileName.split(/[\\/]/).pop() || doc.fileName,
    isDirty: doc.isDirty,
    isUntitled: doc.isUntitled,
    relativePath: rel && !isAbsolutePathLike(rel) ? rel : undefined,
  };
}

/**
 * 读取活动编辑器**注入正文**（**昂贵**：`getText()` 全篇 + 超上限截断）
 *
 * 与 {@link snapshotDocContext} 分家的唯一理由：正文读取只该发生在「脏 / 未命名 / 工作区外」
 * 这三类**真注入**路径上，不该被每击键触发的显示订阅带上（那是修复「缓存撒谎」时引入的效率回退）。
 * 返回体格式（`文件名：{name}\n{正文}`）是信封契约的一部分，勿在此改格式。
 *
 * @param editor 活动编辑器（调用方须确知本轮会注入正文，通常已由 {@link docInjectReason} 判定）
 */
export function readDocBody(editor: vscode.TextEditor): string {
  const doc = editor.document;
  const fileName = doc.fileName.split(/[\\/]/).pop() || doc.fileName;
  const content = doc.getText();
  const truncated =
    content.length > MAX_DOC_CONTEXT_CHARS
      ? `${content.slice(0, MAX_DOC_CONTEXT_CHARS)}\n\n…[内容过长已截断]`
      : content;
  return `文件名：${fileName}\n${truncated}`;
}

/**
 * 「为什么必须注入正文」的**唯一判据**（undefined = 不必注入，走指针）
 *
 * 引用模式（HOST-CTX-0 定案）的前提是「**磁盘是真相**」，只给指针让模型自己读。以下三种
 * 情形磁盘不是真相，给指针会让模型读到错内容 / 读不到，故必须注入：
 *   ① `dirty` 有未保存修改（buffer ≠ 磁盘）；② `untitled` 未命名（无磁盘版本）；
 *   ③ `outside` 不在工作区内（相对路径无意义）。
 * 其余一律只给指针。**判据以原因枚举表达，布尔与 UI 文案都由它派生**——若判据返回布尔、
 * 原因另算一套 if 链，chip 就会出现「说已注入却说不出为什么」的漂移。
 */
export function docInjectReason(s: DocContextSnapshot): 'dirty' | 'untitled' | 'outside' | undefined {
  if (s.isDirty) return 'dirty';
  if (s.isUntitled) return 'untitled';
  if (!s.relativePath) return 'outside';
  return undefined;
}

/** 是否必须注入正文（布尔视图，由 {@link docInjectReason} 派生，不独立判定） */
export function mustInjectDocBody(s: DocContextSnapshot): boolean {
  return docInjectReason(s) !== undefined;
}

/**
 * 活动文件投影（**显示用**，见协议 `ActiveFileProjection`）
 *
 * 只吃「已取到的快照 + 开关态」，不读 vscode 环境（纯函数，可单测）——取快照的地方
 * 与注入判据是**同一处**（{@link ActiveFileTracker.resolveActiveFile}），确保 chip 显示的
 * 就是本轮会发出去的。
 */
export function projectActiveFile(
  snap: DocContextSnapshot | undefined,
  attachEnabled: boolean,
): ActiveFileProjection {
  // 开关关掉时连「有没有文件」都不展示：chip 只表达「当前文件已关闭」，点了就回开。
  // 刻意**不**在「关闭 + 无编辑器」时返回 none——那会把回开入口一起藏掉，用户再打开
  // 文件前没有任何办法把开关打开（死路）。「当前文件未附加」在无文件时依然为真。
  if (!attachEnabled) return { kind: 'suppressed' };
  if (!snap) return { kind: 'none' };
  const reason = docInjectReason(snap);
  return {
    kind: 'attached',
    label: snap.relativePath ?? snap.fileName,
    injected: reason !== undefined,
    ...(reason ? { reason } : {}),
  };
}

/** tracker 唯一反向依赖：消息投递点（由 chatPanel 注入其既有 `post`） */
export interface ActiveFileDeps {
  post: (msg: ExtensionToWebviewMessage) => void;
}

/** {@link ActiveFileTracker.resolveActiveFile} 的一次取数产物（判据与投影同源） */
export interface ActiveFileFacts {
  snap: DocContextSnapshot | undefined;
  inject: boolean;
  projection: ActiveFileProjection;
  body: string;
}

/**
 * 活动文件跟踪器（**模式 A 领域容器**：字段 + 逻辑整体迁出，经 deps 反向依赖宿主投递点）
 *
 * 与 `progressive-refactor-rules.md §4` 的「纯状态容器」的区别：本类**持有业务逻辑**。
 * 原因是该规则的模式 A 只降字段数、不降行数，对本刀「让 chatPanel 减 ~300 行」的目标无效；
 * 故采用模式 B 的职责拆分，但保留模式 A 的「先容器化」次序——字段先成组，再整体搬出。
 */
export class ActiveFileTracker {
  private _attachActiveFile = true;
  /** 活动文件显示投影的上次推送值（JSON）：状态没变就不推，防每次击键刷屏 */
  private _lastActiveFileJson = '';
  /**
   * 活动文件显示订阅（活动编辑器切换 + 文档内容变化）
   *
   * ⚠️ **只喂显示，不喂判据**：注入仍由 `sendInput` 现场取快照决定。这两个事件刻意
   * 覆盖「同一文件被编辑」（`onDidChangeActiveTextEditor` 覆盖不到，正是上一版缓存
   * 判据撒谎的根因）——但订阅产出的只是一份**投影**，随时可由宿主重算，故不构成
   * 第二真理源；发送后还会用本轮实际快照回推一次，抹平「看到」与「发出」的窗口。
   */
  private _activeFileSubs: vscode.Disposable[] = [];

  constructor(private readonly _deps: ActiveFileDeps) {}

  /**
   * 取本轮活动文件事实（**注入判据与 chip 投影的唯一取数点**）
   *
   * 一次快照同时产出两样东西：进信封的 `snap` / `inject`（判据）与给用户看的
   * `projection`（投影）。**两样必须同源**——各算一遍就会出现「chip 说只给指针、
   * 实际却注入了全文」这类自相矛盾，且无法被任何单测发现。
   *
   * **正文惰性（`withBody`）**：显示订阅（{@link pushActiveFile}，每击键触发）走 `withBody=false`，
   * 绝不 `getText()`；只有宿主 `sendInput` 走 `withBody=true`，且仅在本轮**真要注入**时才读正文。
   * 这样「昂贵读取」与「是否真需要」严格绑定，杜绝每击键全量读文档的效率回退。
   */
  resolveActiveFile(withBody = false): ActiveFileFacts {
    // 开关关掉 ⇒ 连快照都不取：指针与正文一并消失（无「关了还挂指针」中间态）
    const editor = this._attachActiveFile ? vscode.window.activeTextEditor : undefined;
    const snap = snapshotDocContext(editor);
    const inject = !!snap && mustInjectDocBody(snap);
    return {
      snap,
      inject,
      projection: projectActiveFile(snap, this._attachActiveFile),
      // 正文只在本轮真要注入、且调用方索取（withBody）时才读——显示路径零 getText
      body: withBody && inject && editor ? readDocBody(editor) : '',
    };
  }

  /** 推送活动文件投影的唯一投递点（`force` 绕状态去重，用于重建后补推 / 发送后回推） */
  postActiveFile(projection: ActiveFileProjection, force: boolean): void {
    const json = JSON.stringify(projection);
    if (!force && json === this._lastActiveFileJson) return;
    this._lastActiveFileJson = json;
    this._deps.post({ type: 'active_file', projection });
  }

  /** 现取现推（事件驱动 / ready 补推的入口） */
  pushActiveFile(force = false): void {
    this.postActiveFile(this.resolveActiveFile().projection, force);
  }

  /**
   * 注册活动文件显示订阅（幂等：先释放旧的再注册，防折叠/展开反复重建累积监听）
   *
   * 三个事件缺一不可（各自覆盖一种「显示会变」的路径；注意**分居两个命名空间**——
   * 活动编辑器在 `window`，文档变化/保存在 `workspace`，曾在 window 上找后者而编译不过）：
   *   - `window.onDidChangeActiveTextEditor`：换文件；
   *   - `workspace.onDidChangeTextDocument`：**同一文件被编辑**（上一版拿活动编辑器缓存当
   *     判据就是栽在覆盖不到这条上），只处理活动文档自身，避免无关文档刷屏；
   *   - `workspace.onDidSaveTextDocument`：保存不改内容 ⇒ 不触发上一条，但 `isDirty` 会翻成
   *     false，不订阅就会出现「已保存还标着未保存」的假徽记。
   */
  ensureActiveFileTracking(): void {
    this.disposeActiveFileTracking();
    this._activeFileSubs = [
      vscode.window.onDidChangeActiveTextEditor(() => this.pushActiveFile()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.pushActiveFile();
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.pushActiveFile()),
    ];
    // 新视图是空白：清掉去重基线，否则「状态没变」会把 ready 后的首推吞掉。
    // **注册时不推**：此刻 webview 脚本尚未就绪（监听器未注册），推了也是丢；
    // 补推由宿主 handleWebviewReady 统一承担（force 绕去重），顺带保证「重建一次即补一次」。
    this._lastActiveFileJson = '';
  }

  /** 释放活动文件显示订阅（视图销毁 / 重注册前调用） */
  disposeActiveFileTracking(): void {
    for (const sub of this._activeFileSubs) sub.dispose();
    this._activeFileSubs = [];
  }

  /**
   * 开关「附加当前打开文件」（W→E 消息入口）
   *
   * 同态直接返回：避免点了又点造成无意义重推（重推本身无害，但会让 `force` 语义变糊）。
   */
  setActiveFileAttach(enabled: boolean): void {
    if (this._attachActiveFile === enabled) return;
    this._attachActiveFile = enabled;
    this.pushActiveFile(true);
  }
}
