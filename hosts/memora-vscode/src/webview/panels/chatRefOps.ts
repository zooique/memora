/**
 * 对话面板 · 引用入口域（自 `chatPanel.ts` 按 op 组外置 · B9-D-2）
 *
 * 职责：引用 chip 的**打开定位**（`open_ref`）与 `@` 提及选择器（`mention_open`）。
 * 两者同属「引用的入口/出口」这一条链：一个把指针跳过去看，一个把指针挂上来；
 * 路径判据共用 `refPath`（首根 SSOT），故同模块承载，不拆两处。
 *
 * 为什么外置：`chatPanel.ts` 行数贴死 `max-lines`；而本域**不碰会话状态**——
 * 依赖面只有 3 个窄接口（投递 / 引用缓冲 / 视图就绪判定），in-flight 标志收进闭包，
 * 与面板的流控、锁、装配全无关，按语义切得开。
 *
 * 本地化：可见文案全走 `vscode.l10n.t`，键 = 英文源文案本身（宿主机契约）。
 */
import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { ChatRef, ExtensionToWebviewMessage, InjectionSource } from '../../shared/protocol.js';
// 引用路径 ↔ 首根的双向判据唯一真源 = refPath：生成侧 relativeUnderPrimaryRoot（本模块 @ 列表用）
// 与消费侧 resolveUnderPrimaryRoot（本模块打开引用用）同模块，两半分居必漂移。
import { relativeUnderPrimaryRoot, resolveUnderPrimaryRoot } from '../../extension/host/refPath.js';
// 列工作区文件的排除 glob 单一真源（HOST-CTX-14）：派生自内核 IGNORED_DIR_NAMES；
// findFiles 只吃 files.exclude，不显式传 exclude 时 node_modules 等噪音会挤占上限
// （排除语义实读见 ignoredDirs.ts）
import { IGNORED_DIR_GLOB } from '../../extension/host/ignoredDirs.js';
// 注入源命名单一真源（HOST-CTX-4 ①）：@ 下拉 label 与 chip 短名 / 信封头同读一处，勿内嵌字面量
import { MOUNTABLE_INJECTION_META } from '../../shared/injectionSourceMeta.js';

/**
 * HOST-CTX-1：@ 提及 QuickPick 的 findFiles 结果上限（防超大仓首开卡顿）
 *
 * 命中上限 = `findFiles` **静默截断**（超限返回上限条数、遍历序非确定、不报错）——「静默失败」族。
 * 故命中时必须在 placeholder 告知「已截断、请输关键词缩小范围」（HOST-CTX-11 补，此前无提示）；
 * 提为常量是为了测试断言同一个数，不各写一份字面量。
 */
export const MENTION_FILE_LIMIT = 2000;

/** 引用入口域的注入面（唯一构造点 = 面板字段初始化处） */
export interface ChatRefOpsDeps {
  /** 向 webview 投递协议消息（面板 `post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 引用缓冲入口（视图未就绪时由面板暂存、ready 后补发） */
  pushRefs: (refs: ChatRef[]) => void;
  /** 视图是否就绪（决定 addRef 直投还是退化到缓冲） */
  hasView: () => boolean;
}

/** 引用入口域对外方法（面板只做转发） */
export interface ChatRefOps {
  openRefInEditor(ref: ChatRef): Promise<void>;
  openMentionQuickPick(): Promise<void>;
}

/**
 * 构造引用入口域
 *
 * @param deps 面板注入的窄接口（见 {@link ChatRefOpsDeps}）
 */
export function createChatRefOps(deps: ChatRefOpsDeps): ChatRefOps {
  /**
   * @ 提及 QuickPick 是否正开着（HOST-CTX-11）：防连按 @ 时后开的列表静默覆盖先开的。
   * 纯 in-flight 标志（不缓存任何选中/意图），`try/finally` 保证异常路径也归位——
   * 否则一次 findFiles 抛错就把这个门永久焊死。状态随本域一起外置（面板不再持有）。
   */
  let mentionQuickPickOpen = false;

  return {
    /**
     * 引用 chip 点击 → 在编辑器打开并定位（open_ref，W→E 分支）
     *
     * 语义（协议 open_ref 注释为 SSOT）：引用是指针，**点指针就该跳过去看**——文件（无论有无行
     * 区间）打开文档 + reveal，有区间则选中高亮（用户由此直接看到「我到底加了哪几行」，无需数行）；
     * 目录则在资源管理器露出（目录没有「打开成文档」的概念）。
     *
     * 路径解析：`ref.path` 是**首根下的相对路径**（生产点 = extension.ts addToChat，经
     * `refPath.relativeUnderPrimaryRoot` 产出规范形）。项目根**恒取 `workspaceFolders[0]`**，与内核
     * 同源——内核 `read_file` 的 cwd 只有一个根，逐根遍历会在多根工作区打开第二根的同名文件，而
     * 模型读的是首根那份 ⇒ 用户核对的与模型读到的**不是同一个文件**（伪多根支持，已删）。解析与
     * 越界守卫收口在 `refPath.resolveUnderPrimaryRoot`——与生成侧**同一模块同一判据**（绝对路径 /
     * `..` 段 / 非规范形一律拒，解析结果须往返落回首根），webview 上行通道不能各写一套字符串守卫。
     * 行号是**指针不是快照**（协议 ChatRef 注释）：引用后文件可能已改短，区间越界——统一 clamp 到
     * 文档末尾，不让 Position/lineAt 抛异常（仍定位到最接近的行）。
     *
     * 失败态（文件已删 / 不可读 / 无工作区 / 路径越界）：一律走面板 notice 单一出口（与其它用户
     * 可见反馈同 surface，不混用 showWarningMessage 弹 toast）。
     */
    async openRefInEditor(ref: ChatRef): Promise<void> {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) {
        deps.post({
          type: 'notice',
          level: 'error',
          message: vscode.l10n.t('No workspace open; no reference target'),
        });
        return;
      }
      // 越界路径拒绝（判据 SSOT = refPath.resolveUnderPrimaryRoot，与 addToChat 生成侧同模块）：
      // ref.path 由 webview 回传，等于一条「打开任意文件」的上行通道——绝对路径 / `..` 段 /
      // 非规范形一律不解析，解析结果须往返落回首根（详见 refPath.ts 顶部契约）。
      const abs = resolveUnderPrimaryRoot(root.uri.fsPath, ref.path);
      if (!abs) {
        deps.post({
          type: 'notice',
          level: 'error',
          message: vscode.l10n.t('Cannot open reference: {0}', ref.path),
        });
        return;
      }
      const uri = vscode.Uri.file(abs);
      try {
        if (ref.kind === 'folder') {
          await vscode.commands.executeCommand('revealInExplorer', uri);
          return;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        if (ref.range) {
          // 协议 1-based 闭区间 → VS Code 0-based：逆转换唯一收口（协议 ChatRef 注释 SSOT，
          // webview 与协议层保持 1-based，两处各转一次必漂移）
          const lastLine = Math.max(0, doc.lineCount - 1);
          const startLine = Math.min(Math.max(ref.range.start - 1, 0), lastLine);
          const endLine = Math.min(Math.max(ref.range.end - 1, startLine), lastLine);
          const start = new vscode.Position(startLine, 0);
          const end = doc.lineAt(endLine).range.end;
          editor.selection = new vscode.Selection(start, end);
          editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
      } catch (err) {
        deps.post({
          type: 'notice',
          level: 'error',
          message: vscode.l10n.t('Cannot open reference: {0}', ref.path),
        });
        console.warn(`Memora open_ref 失败 [${ref.path}]`, err);
      }
    },

    /**
     * HOST-CTX-1：@ 提及的文件选择器（输入框键入 @ 触发，W→E `mention_open`）
     *
     * 语义红线（引用模式定案）：@ 只是「挂引用的快捷入口」——选中即走 addRef 推送挂 chip，
     * **零内容注入**，不照搬主流 @ 提及的「全文进上下文」语义。
     *
     * 三个 SSOT 归属（本方法零自建）：① 文件列表 = `vscode.workspace.findFiles`（VS Code SSOT：
     * ripgrep 模糊检索，webview 不养索引副本）——⚠️ 排除语义按 2026-10-20 源码一手实读订正
     * （extHostWorkspace.ts）：只应用 `files.exclude`、**不应用** `search.exclude`、`.gitignore`
     * **默认不尊重**（VS Code 1.87 起硬编码，PR #204845；opt-in 开关
     * `search.experimental.useIgnoreFilesInFindFiles`）⇒ 忽略目录必须显式传 `IGNORED_DIR_GLOB`
     * （HOST-CTX-14，真源 `ignoredDirs.ts`，与 projectSearchProvider 同挂），传 `undefined` 时
     * node_modules 等会挤占上限；② 首根归属判据 = `relativeUnderPrimaryRoot`（与 addToChat 生成侧
     * 同源，第二根 / 根外文件 fail-closed 不列出——挂一条注定读错的指针比不挂更坏）；③ 挂载链路
     * = `pushRefs` 的 addRef 推送（source='mention'，webview 据此撤触发 @）。
     *
     * 边界：findFiles 只列**文件**，目录 @ 不支持（目录引用沿用资源管理器右键入口，那里有
     * explorer/context 菜单）；上限 `MENTION_FILE_LIMIT` 条防超大仓首开卡顿，命中即静默截断
     * （findFiles 语义）⇒ placeholder 必须明示，否则用户搜不到目标文件还以为没有（HOST-CTX-11）。
     */
    async openMentionQuickPick(): Promise<void> {
      // in-flight 守卫（HOST-CTX-11）：连按两次 @ 会各来一条 mention_open。不拦的话后开的
      // QuickPick 静默覆盖先开的（VS Code 语义：新 show 使旧的 hide → 旧的 resolve
      // undefined 丢弃），且 webview 的 mentionTriggerOffset 已被第二次覆盖 ⇒ 最终只撤一个
      // @、另一个残留正文。列表已开着时再来一条 = 用户没看到响应，最合理的解释就是
      // 「已经在开着的状态」，静默返回即可。
      if (mentionQuickPickOpen) return;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        // 未打开工作区：引用判据（首根相对路径）无处安放，提示而非静默失败
        void vscode.window.showInformationMessage(
          vscode.l10n.t('No workspace open; no reference target'),
        );
        return;
      }
      mentionQuickPickOpen = true;
      try {
        const uris = await vscode.workspace.findFiles('**/*', IGNORED_DIR_GLOB, MENTION_FILE_LIMIT);
        // 首根归属判定前置到列表期（fail-closed）：第二根 / 根外的文件连列表都不进，
        // 用户选不到就挂不上——与 addToChat 拒挂第二根是同一契约的两半。
        // @ 下拉的两类项：**文件项**（挂指针，走 addRef）+ **特殊关键字项**（走 add_injection，
        // 挂载注入型上下文）。与 Roo Code / Cursor 同款（下拉里除文件外还建议 problems /
        // terminal / git-changes 这类关键字）；关键字项恒置顶，不与文件项混排。
        type MentionItem = vscode.QuickPickItem & {
          rel?: string;
          injection?: Exclude<InjectionSource, 'active-file'>;
        };
        const fileItems: MentionItem[] = [];
        for (const uri of uris) {
          const rel = relativeUnderPrimaryRoot(root, uri.fsPath);
          if (!rel) continue;
          fileItems.push({ label: basename(rel), description: rel, rel });
        }
        fileItems.sort((a, b) => (a.description ?? '').localeCompare(b.description ?? ''));
        // 关键字项由 MOUNTABLE_INJECTION_META **派生**（加源零改本处——第 1 笔 Record
        // 穷尽性兜底：新源漏配 meta 即 tsc 红）。label / description 值真源 = 该单点。
        const mountableItems: MentionItem[] = (
          Object.keys(MOUNTABLE_INJECTION_META) as Exclude<InjectionSource, 'active-file'>[]
        ).map((source) => ({ ...MOUNTABLE_INJECTION_META[source].quickPick, injection: source }));
        const items: MentionItem[] = [...mountableItems, ...fileItems];
        // 截断告知（HOST-CTX-11）：>= 上限即视为可能截断（恰好等于上限不截断的极小概率
        // 也在提示范围内——多一句提示远好过用户找不到文件）。走 placeholder 而非塞一条
        // 「提示项」进 items：QuickPickItem 没有 disabled，提示项一旦被选中就会变成一条
        // path 是文案的伪引用。
        const truncated = uris.length >= MENTION_FILE_LIMIT;
        const qp = vscode.window.createQuickPick();
        qp.items = items;
        qp.canSelectMany = true;
        qp.matchOnDescription = true;
        // placeholder 内嵌的关键字项 label 从同一派生数组取（勿在此内嵌字面量——
        // 曾两处各写一句「诊断（问题面板）」、改一处漏一处 = 下拉提示与实际选项对不上）
        const mountableHint = mountableItems.map((i) => i.label).join(' / ');
        qp.placeholder = truncated
          ? vscode.l10n.t(
              'File count exceeds {0} and has been truncated (built-in ignored directories already excluded); type keywords to narrow down (multi-select, Esc to cancel)…',
              MENTION_FILE_LIMIT,
            )
          : vscode.l10n.t(
              'Select a file to attach as a reference, or pick {0} to inject context (multi-select, Esc to cancel)…',
              mountableHint,
            );
        qp.show();
        const picked = await new Promise<readonly MentionItem[] | undefined>((resolve) => {
          // accept = 确认（含多选）；hide = Esc / 点外部关闭（两者互斥，先到先 resolve）
          qp.onDidAccept(() => resolve(qp.selectedItems));
          qp.onDidHide(() => resolve(undefined));
        });
        qp.dispose();
        // 焦点归还（HOST-CTX-16）：QuickPick 是宿主全局 UI，开启时焦点被它拿走，Esc 取消 /
        // 确认收场后 VS Code 都不会自动还给 webview 里的输入框 ⇒ 用户想继续打字得先点一下。
        // accept / cancel 两条路都经过这里——一条 post 覆盖两路，不各写一份。
        // 例外：findFiles 抛错 / 未打开工作区时 QuickPick 从未开出，焦点没被拿走，不发。
        deps.post({ type: 'focus_input' });
        if (!picked || picked.length === 0) return; // 取消：静默返回，正文里的 @ 保留（用户可继续编辑）
        // 关键字项与文件项**分道**：关键字项挂注入 chip（add_injection），文件项挂引用 chip
        // （addRef）。刻意不复用 addRef——ChatRef 的契约是「只挂指针不携内容」（CTX-4 前置边界）。
        // 泛化：不再按源名分支——MOUNTABLE_INJECTION_META 有几源就挂几源（加源零改此处）。
        const mounted: Exclude<InjectionSource, 'active-file'>[] = [];
        const refs: ChatRef[] = [];
        for (const p of picked) {
          if (p.injection) {
            mounted.push(p.injection);
            continue;
          }
          // 防御：QuickPickItem.description 类型可选，本 items 恒有值——异常缺省则跳过
          // （不挂 path=undefined 的伪引用）
          if (typeof p.description !== 'string') continue;
          refs.push({ path: p.description, kind: 'file' });
        }
        // via='mention'：与 addRef 同款，让 webview 撤掉输入框里那个 '@'（只选关键字项时
        // 如果没有这条，'@' 会残留在正文里被一起发出去）。
        for (const source of mounted) {
          deps.post({ type: 'add_injection', source, via: 'mention' });
        }
        if (refs.length === 0) return;
        if (deps.hasView()) {
          deps.post({ type: 'addRef', refs, source: 'mention' });
        } else {
          // 退化路径（HOST-CTX-11 订正）：**不是**「webview 未就绪」——mention_open 只能从
          // webview 发出，收到时视图必然在；唯一可达场景 = QuickPick 打开期间视图被销毁
          // （侧栏折叠/切走）。走引用缓冲、下次 ready 补发（不带 source ⇒ @ 不撤）。
          // 取舍：选中是用户显式意图，缓冲保留它；代价是 chip 可能在用户已切换上下文后才
          // 出现（早期注释低估，订正于此——不挂则用户白选）。
          deps.pushRefs(refs);
        }
      } finally {
        mentionQuickPickOpen = false;
      }
    },
  };
}
