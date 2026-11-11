/**
 * 附件行渲染域（活动文件 chip / 注入 chip / 引用回复胶囊 / 引用 chip 编排 / 注入回执）
 *
 * 从 chatView.ts 外置的自足渲染单元（CHATPANEL-MARGIN-1 第一刀）：chatView.ts 物理行数已贴死
 * eslint max-lines 上限（只降不升），而「附件行里每个 chip 长什么样、点哪儿干什么」本来就是
 * 一段自足逻辑。
 *
 * 边界（守 SSOT）：本模块**只产 DOM、不持状态**——`activeFile` / `activeFileTokens` /
 * `currentInjections` / `currentRefs` 的真源仍在 chatView 闭包；每次渲染由调用方传入状态快照，
 * 交互一律经回调回流（与 refChips / skillPickerView 同构，不造第二份附件状态）。
 *
 * 行内顺序 = 视觉顺序：活动文件（常态背景）→ 注入（带内容）→ 引用回复胶囊 → 引用 chip。
 *
 * @module attachmentRowView
 */
import * as l10n from '@vscode/l10n';
import type {
  ActiveFileProjection,
  ChatRef,
  InjectionSegment,
  InjectionSummary,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import {
  INJECTION_SEGMENT_LABELS,
  MOUNTABLE_INJECTION_META,
  type MountableInjectionSource,
} from '../../shared/injectionSourceMeta.js';
import { appendRefChips, refDisplayName, type RefChipHandlers } from '../helpers/refChips.js';
import { syncRowEdges } from '../helpers/chipRow.js';
import { fmtTokens } from '../helpers/fmtTokens.js';
import { getIconSvg } from './icons.js';

/** 引用 chip 状态：协议 ChatRef + webview 持有的锁 / 失效投影（真源在调用方） */
export type RefChip = ChatRef & { pinned: boolean; missing?: boolean };

/** 一次渲染的状态快照（调用方每次重绘取一份，本模块只读不改写） */
export interface AttachmentRowState {
  /** 活动文件投影（宿主推送，**纯显示**） */
  activeFile: ActiveFileProjection;
  /** 活动文件的本轮注入量（仅发送后回推有值；无值时不显示规模，不造假数） */
  activeFileTokens?: number;
  /** 本轮挂载的注入型来源（数组顺序即 chip 顺序） */
  injections: readonly MountableInjectionSource[];
  /** 当前引用全量（含钉住态 / 宿主下发的失效投影） */
  refs: readonly RefChip[];
  /** 引用回复快照胶囊（无草稿 = null） */
  quoteChip: HTMLElement | null;
}

/** 附件行渲染域依赖 */
export interface AttachmentRowViewDeps {
  /** webview document（DOM 构造入口） */
  document: Document;
  /** 附件行容器 #refChips（三类 chip 共用一个容器） */
  row: HTMLElement | null;
  /** 圆环 hover 卡片底部「本轮注入」回执行 #occInjection */
  receipt: HTMLElement | null;
  /** 上行消息（活动文件附加开关：开 / 关） */
  post(msg: WebviewToExtensionMessage): void;
  /** 移除一枚注入 chip；从真源过滤 + 重绘由调用方完成 */
  onRemoveInjection(source: MountableInjectionSource): void;
  /** 引用 chip 交互出口（打开 / 钉住 / 移除 / 清空，全部归调用方改真源） */
  refHandlers: RefChipHandlers;
}

/** 附件行渲染域窄接口：chatView 只经这三面驱动，内部函数零暴露 */
export interface AttachmentRowView {
  /** 全量重绘附件行（先清空再按状态快照重建） */
  render(state: AttachmentRowState): void;
  /** 注入回执渲染（发送后一次性，由 `injection_summary` 驱动） */
  renderInjectionReceipt(summary: InjectionSummary): void;
  /** 回执归零（新一轮发送 / 清空会话 / 本轮无注入） */
  hideInjectionReceipt(): void;
}

/**
 * 创建附件行渲染域容器。
 *
 * @param deps 容器 / 回执行两个 DOM 出口 + 三类交互回流（上行 / 移除注入 / 引用 chip 出口）
 */
export function createAttachmentRowView(deps: AttachmentRowViewDeps): AttachmentRowView {
  const { document, row, receipt, post, onRemoveInjection, refHandlers } = deps;

  /**
   * 注入原因 → 展示短语（唯一产地：chip 徽记与 title 共用，别在调用点各写一套）
   *
   * 值 = **英文源键**（l10n 键面）：本模块在 `initWebviewL10n` 之前即被 import，
   * 表内不可预解析成译文（早于 config 的 t() 只会拿到键）——解析放在调用点，
   * 见 `activeFileReasonLabel`。
   */
  // @nls-keys
  const ACTIVE_FILE_REASON_LABELS: Record<'dirty' | 'untitled' | 'outside', string> = {
    dirty: 'Unsaved',
    untitled: 'Untitled',
    outside: 'Outside workspace',
  };

  /**
   * 取注入原因的本地化短语（表内存英文源键，此处统一过 l10n.t）
   *
   * @param reason 注入原因（缺省按 dirty 处理：宿主未给原因时最常见的是未保存）
   */
  function activeFileReasonLabel(reason?: 'dirty' | 'untitled' | 'outside'): string {
    return l10n.t(ACTIVE_FILE_REASON_LABELS[reason ?? 'dirty']);
  }

  /**
   * token 数的短显（3258 → ≈3.3k；842 → 842）
   *
   * @param n token 数
   * @returns 短显串（chip 徽记空间窄，长数字难扫读）
   */
  function formatTokensShort(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  /**
   * 活动文件 chip（**第三种 chip**，与 skill / ref 同构）
   *
   * 把「当前打开文件会不会进本轮上下文」摊在输入框上方——此前它完全隐形，用户既看不到
   * 也没法关。两形态：
   *   - attached：`📄 白话设计文档.md · 未保存（全文已附）` + ✕（本会话不再附加）
   *   - suppressed：虚线胶囊「当前文件未附加 · 点击启用」（整枚可点回开，不留死路）
   *
   * 为什么要标「全文已附」：干净文件只给指针（不占预算），脏/未命名/工作区外才注入正文
   * （3~4k token）。不标，用户永远看不懂「这条消息为什么突然贵了、模型为什么看到了我
   * 没保存的东西」。**文案与 HOST-CTX-6 预算可视化共用这一句**，不拆两处。
   * CTX-6② 归因：发送后的本轮回推（`injection_summary` 的 active-file 分项）给出 token 数，
   * 徽记短显 `≈3.3k`、title 给全数——让「这轮贵在哪」有归因入口（圆环只示总量，这里示出处）。
   * ⚠️ 数字不再长在投影字段上（HOST-CTX-4 ②：三个源各挂一个字段 = 并列腐化），统一由
   * 汇总投影按源分项下发，见 chatView 里 `activeFileTokens` 变量的预备/认领契约。
   *
   * 视觉上复用 `.skill-chip` 基类（不造新范式）；suppressed 复用 `.is-disabled`
   * （虚线 + 次要色，语义正是「挂着但不会生效」）。
   *
   * @param p      活动文件投影
   * @param tokens 本轮注入量（undefined = 本轮规模未知，不显示）
   */
  function buildActiveFileChip(
    p: ActiveFileProjection,
    tokens: number | undefined,
  ): HTMLElement | null {
    if (p.kind === 'none') return null;
    const icon = (): HTMLElement => {
      const el = document.createElement('span');
      el.className = 'skill-chip__icon';
      el.innerHTML = getIconSvg('file', 11, 11);
      el.setAttribute('aria-hidden', 'true');
      return el;
    };
    if (p.kind === 'suppressed') {
      // 整枚是按钮：关闭态若只显示不给回开入口，就成了用户抱怨过的「关不掉」的反面
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'skill-chip active-file-chip is-disabled';
      chip.dataset.activeFile = 'suppressed';
      chip.title = l10n.t(
        'Current file is not attached as context (this session) — click to re-enable',
      );
      chip.setAttribute('aria-label', l10n.t('Re-enable current file context'));
      const name = document.createElement('span');
      name.className = 'skill-chip__name';
      name.textContent = l10n.t('Current file not attached');
      const note = document.createElement('span');
      note.className = 'skill-chip__note';
      note.textContent = l10n.t('Click to enable');
      chip.append(icon(), name, note);
      chip.addEventListener('click', () => {
        post({ type: 'set_active_file_attach', enabled: true });
      });
      return chip;
    }
    const chip = document.createElement('span');
    chip.className = 'skill-chip active-file-chip';
    chip.dataset.activeFile = 'attached';
    chip.appendChild(icon());
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    // HOST-CTX-18 降噪（对齐 CTX-17 引用气泡）：可见文本只留文件名，完整相对路径降级到
    // title 末尾括号（hover 可辨）——投影 label 仍是全路径（aria-label 与去重判据都用它）。
    // 活动文件永远只有一个，不存在引用气泡那种同名撞车，纯文件名无歧义代价。
    name.textContent = refDisplayName(p.label);
    // title 承载「本轮以什么方式附加」——不能只靠徽记（窄面板下徽记可能被省略号吃掉）。
    // 注入量归因（CTX-6②）：数字只在「发送后本轮回推」里出现（非常驻值，下一次不带汇总
    // 的投影推送即抹掉），挂在「全文已附」同一句上——CTX-3/CTX-6 文案不拆两处。
    // CTX-18：完整路径附在末尾括号——可见文本降噪后，目录位置靠 hover 这一眼。
    name.title = p.injected
      ? l10n.t(
          'Full text attached this turn ({0}){1} ({2})',
          activeFileReasonLabel(p.reason),
          tokens !== undefined ? l10n.t('· ~{0} tokens (estimated)', String(tokens)) : '',
          p.label,
        )
      : l10n.t(
          'Path pointer only this turn; model reads content on demand (no budget cost) ({0})',
          p.label,
        );
    chip.appendChild(name);
    if (p.injected) {
      const note = document.createElement('span');
      note.className = 'skill-chip__note';
      // 徽记带短显估算（≈3.3k）：全数字（3258）在窄 chip 里挤且难扫读；无值时不显示
      // （常态附加 chip = 判据已知、本轮规模未知，不造假数）
      note.textContent =
        l10n.t('{0} · full text attached', activeFileReasonLabel(p.reason)) +
        (tokens !== undefined ? ` ≈${formatTokensShort(tokens)}` : '');
      chip.appendChild(note);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.innerHTML = getIconSvg('close', 11, 11);
    remove.setAttribute('title', l10n.t('Stop attaching current file this session'));
    remove.setAttribute('aria-label', l10n.t('Close current file context: {0}', p.label));
    remove.addEventListener('click', () => {
      post({ type: 'set_active_file_attach', enabled: false });
    });
    chip.appendChild(remove);
    return chip;
  }

  /** 回执归零（新一轮发送 / 清空会话 / 本轮无注入）：不做「本轮注入 0」这种无信息显示 */
  function hideInjectionReceipt(): void {
    if (!receipt) return;
    receipt.hidden = true;
    receipt.textContent = '';
  }

  /**
   * 注入型上下文 chip（**第四种 chip**，HOST-CTX-4）
   *
   * 与引用 chip 的根本差别：引用只挂指针（模型按需读），注入 chip **当轮就把内容塞进信封**
   * ——因为诊断 / git 变更 / 终端输出这类瞬态数据在内核工具箱里**没有对应读取工具**，
   * 「提示模型去看」此路不通（见 HOST-CTX-0 例外的理由）。
   *
   * 可辨性（硬约束③「明示」）：与引用 chip 并排在同一行，故**形状 + 颜色双通道**区分——
   * 圆角矩形（非胶囊）+ warn 色实线边框 + ⚠ 图标 + 「内容已注入」短标。
   * ⚠️ 不用半透明 / 低对比度表达：真机证过半透明 chip 看着像未渲染（CTX-17 同款教训）。
   *
   * 无 🔒（硬约束④「不泛化」）：常驻 = 每轮都悄悄塞一份进信封，用户会失去预算控制；
   * 要再用就重新挂一次。✕ 即移除（从 currentInjections 过滤，单一真理源）。
   *
   * @param source 注入来源（枚举即身份判据）
   */
  function buildInjectionChip(source: MountableInjectionSource): HTMLElement {
    const meta = MOUNTABLE_INJECTION_META[source];
    const sourceName = l10n.t(INJECTION_SEGMENT_LABELS[source]);
    const chip = document.createElement('span');
    // .skill-chip 基类 + .injection-chip 差异化（形状 / 颜色）；data-injection 是测试锚点
    chip.className = 'skill-chip injection-chip';
    chip.dataset.injection = source;
    const icon = document.createElement('span');
    icon.className = 'skill-chip__icon';
    icon.innerHTML = getIconSvg('warning', 11, 11);
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = sourceName;
    // 可见文本只有四个字，全部说明进 title（hover 第一问就是「这挂的是啥、占不占」）
    name.title = l10n.t(meta.chip.title);
    const note = document.createElement('span');
    note.className = 'skill-chip__note';
    note.textContent = l10n.t(meta.chip.note);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.innerHTML = getIconSvg('close', 11, 11);
    remove.setAttribute('title', l10n.t('Remove: {0}', sourceName));
    remove.setAttribute('aria-label', l10n.t('Remove {0} injection', sourceName));
    remove.addEventListener('click', () => {
      // 状态改动归调用方（真源 = currentInjections），本模块只上报「哪一枚被点掉」
      onRemoveInjection(source);
    });
    chip.append(icon, name, note, remove);
    return chip;
  }

  /**
   * 圆环 hover 卡片底部「本轮注入」回执行（HOST-CTX-4 ② 的呈现落点）
   *
   * 一次性回执：只在**发送后**由 `injection_summary` 驱动，下一轮发送 / 清空会话时清。
   * 显示判据 = 至少一个分项真的注入了内容且合计 > 0——「本轮注入 0」是纯噪音，
   * 且会让人误以为「挂了但没生效」。
   * 分项明细**同屏可见**（徽记时代只能进 title）：hover 卡片本就是「精确」层，
   * 明细没有理由再藏一层；数字口径与卡片其余行统一走 `fmtTokens`（精确式）。
   *
   * @param summary 本轮注入汇总（按源分项）
   */
  function renderInjectionReceipt(summary: InjectionSummary): void {
    if (!receipt) return;
    // 类型谓词收窄（不是「过滤后再取」）：分项名后跟的必须是 number，若过滤条件改松，
    // `${s.tokens}` 会静默印出 `undefined`——收窄后 tsc 直接拦住。
    const injected = summary.segments.filter(
      (s): s is InjectionSegment & { tokens: number } => s.injected && typeof s.tokens === 'number',
    );
    if (summary.total <= 0 || injected.length === 0) {
      hideInjectionReceipt();
      return;
    }
    const detail = injected
      .map((s) => `${l10n.t(INJECTION_SEGMENT_LABELS[s.source])} ${fmtTokens(s.tokens)}`)
      .join(' · ');
    receipt.textContent = l10n.t(
      'Injected this turn {0} ({1}) · estimated at send time, overwritten next turn',
      fmtTokens(summary.total),
      detail,
    );
    receipt.hidden = false;
  }

  /**
   * 构建/清空附件行：**活动文件 chip + 注入 chip + 引用 chip** 共用一个容器（`#refChips`）。
   *
   * 引用 chip 形态：`文件名(+行号) + 🔒 + ×`（HOST-CTX-17 降噪：可见文本只留文件名，
   * 完整相对路径降级到 title / aria-label——hover 与屏幕阅读器仍拿得到，见 refDisplayName），
   * 与技能 chip 同构复用 `.skill-chip*` 样式；
   * 🔒 切 pinned（发送后是否保留），× 移除 = 从 currentRefs 过滤并刷新（单一真理源），
   * 文件名/行号 span 点击 = 上报 open_ref 跳编辑器定位；注入 chip（第四类，⚠ 图标 +
   * 圆角矩形 + warn 色）在活动文件之后、引用之前——它带内容，故与注入方（活动文件）同侧，
   * 与纯指针的引用分开。
   * 显隐判据只写一次（`isEmpty`）：四类 chip 任一存在即显示——分成多处各判一次，
   * 必然出现「refs 清空后活动文件 chip 被连坐隐藏」这类漂移。
   *
   * @param state 本次重绘的状态快照（真源仍在调用方）
   */
  function render(state: AttachmentRowState): void {
    if (!row) return;
    row.textContent = '';
    if (
      state.activeFile.kind === 'none' &&
      state.refs.length === 0 &&
      state.injections.length === 0 &&
      !state.quoteChip
    ) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    // 活动文件在前（常态背景上下文），引用在后（本轮临时挂载）
    const activeChip = buildActiveFileChip(state.activeFile, state.activeFileTokens);
    if (activeChip) row.appendChild(activeChip);
    for (const source of state.injections) row.appendChild(buildInjectionChip(source));
    // 引用回复快照胶囊（COPY-2 形态优化）：快照语义 ≠ 文件指针，但同属「本轮挂载的引用」混排
    if (state.quoteChip) row.appendChild(state.quoteChip);
    // 引用 chip 渲染外置 helpers/refChips.ts（只产 DOM、不持状态）：排序（钉住置顶）、
    // 失效灰显、🔒/✕/清空的语义全在该单点；本处只把「状态改动」与「即时落盘」接起来。
    appendRefChips(row, state.refs, refHandlers);
    // 同一行里既有活动文件 chip 又有引用：重建后必须按新宽度重算渐隐（见 syncRowEdges）
    syncRowEdges(row);
  }

  return { render, renderInjectionReceipt, hideInjectionReceipt };
}
