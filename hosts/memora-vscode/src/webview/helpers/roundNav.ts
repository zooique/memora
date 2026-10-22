/**
 * 会话大纲导航条（HOST-NAV-1）— 右缘按轮锚点 + hover 预览 + 点击定位
 *
 * 形态（ChatGPT 同款范式，台账 HOST-NAV-1）：对话流右缘一列小横条，每轮用户输入一根；
 * 视口内当前轮加粗高亮；hover 弹浮层列各轮用户输入原文预览；点击滚动定位到对应轮。
 * 平时几乎隐形（不滚动/不足两轮时整条隐藏），不占布局。
 *
 * SSOT 决策：
 *  - **锚定对象 = 用户消息气泡 .msg.user，不依赖 roundId**——运行时发送时刻还没有
 *    roundId（meta/chunk 到达才回填），重放路径才有。大纲条只做「定位 + 预览 + 高亮」，
 *    全部可由气泡 DOM 位置与上屏文本表达，绕开「运行时无 id」的时序问题。
 *    🔴 刻意**不锚** `.msg-wrapper`：该外壳由 chatView `append()` 的 else 分支创建，
 *    同时包 **user 与 error** 两种 role，按它会误把 error 气泡算作一轮（多一根条 +
 *    错误文案进预览 + 点击跳到错误气泡）——详见 collect() 注释。
 *  - **预览文本 = 上屏 .msg-body 文本过 stripInjectedContextPrefix**——重放（读落盘
 *    Round，带注入前缀）与运行时（回显原始 input，无前缀）两路上屏形态不同，经同一
 *    纯函数归一；不另从 round-store 拉第二套文本（防运行时与重放两套口径）。
 *  - **重建时机与渲染同源**：调用方（chatView）把 sync 挂进既有 MutationObserver 的
 *    rAF 拍子（吸底同一通道同一节拍），不在各渲染路径埋点；内部用签名比对防流式期
 *    每帧重建。
 *  - **高度与压密 = 本文件唯一所有**（自适应压密，用户拍板「全量条 + 压密」）：CSS
 *    不设条列 max-height，由 applyMetrics 按视口高下发（同源单点）；轮数超出预算时
 *    先压间隙再压条高，极端仍不足交给条列自身滚动兜底（CSS overflow，见 chatStyles）。
 *  - **滚动复用 helpers/scrollToBottom**：点击定位后显式 trackScroll 重算吸底标记
 *    （程序化 scrollTop 赋值是否派发 scroll 事件不确定，对齐 jumpToBottom 纪律），
 *    不复制吸底逻辑。
 *
 * 几何与 jsdom：高亮判定依赖 getBoundingClientRect（jsdom 恒 0），故判定逻辑抽成
 * 纯函数 computeActiveIndex（tops 数组入参），DOM 几何只在控制器层读取——纯函数
 * 直接单测，DOM 层测试打桩（对齐 chatView.test.ts stubScroll 既有纪律）。
 */
import { stripInjectedContextPrefix } from './docContext.js';
import { trackScroll } from './scrollToBottom.js';

/** 定位落点：目标块顶滚到容器可视顶下方该像素（留一点呼吸空隙） */
const JUMP_INSET = 12;

/** 当前轮判定阈值：块顶滚入容器可视顶该像素内即视为「已读过」（ChatGPT 同款手感） */
const ACTIVE_THRESHOLD = 96;

/**
 * 贴底几何容差（px）：只吸收 scrollTop 取整 / 页面缩放留下的亚像素残差，
 * 恒远小于任一轮块高（否则会提前跳到最后一轮）。
 *
 * ⚠️ **不复用 scrollToBottom.ts 的 STICKY_THRESHOLD(48)**：那是「吸底**意图**」的宽容度
 * （用户离底 48px 内仍算停留在底部，以免新内容把人拽走），拿它当高亮判据会让距底 48px
 * 时就亮最后一轮——那时最后一轮块多半还没进入视口主区。高亮要的是**几何真值**。
 */
const ACTIVE_BOTTOM_EPS = 2;

/** 浮层预览截断长度（字符）：浮层行宽有限，超长输入截断即可辨认 */
const PREVIEW_MAX = 60;

/* ---- 自适应压密参数（全量条 + 压密，台账 HOST-NAV-1） ---- */
/**
 * 宽松态条高（px）：镜像令牌 --sp-5（12）。
 * ⚠️ 该镜像由 roundNav.test.ts「压密常量镜像守卫」钉死与令牌同值——漂移即红，
 * 不再靠人肉核对（镜像说明见 applyMetrics 注释）。
 */
export const BAR_MAX_H = 12;
/** 极限态条高（px）：细到仍可辨、可点 */
const BAR_MIN_H = 3;
/** 宽松态条间隙（px）：镜像令牌 --sp-2（6），同上由镜像守卫钉死 */
export const GAP_MAX = 6;
/** 极限态条间隙（px） */
const GAP_MIN = 1;
/**
 * 导航条可用高度预算 = 视口高 × 该比例。
 *
 * 取 0.5 的理由：导航条竖向居中锚定（top:50%），占视口高一半即上下各占至 25%~75%
 * 区间，恒不与右下角「一键到底」按钮（贴底约 5% 内）重叠 —— 这正是「侧边栏位置紧张」
 * 的结构性解，而非再挪一个边距。**SSOT：条列高度上限的唯一真源在此**，经 applyMetrics
 * 下发条列内联 max-height；**条列** CSS 不设 max-height（避免第二套值静默漂移）。
 * 浮层视觉盒 `.round-nav__list` 另有 `max-height:50vh`（CSS，C 类）与本比例同判——该对
 * 镜像由 roundNav.test.ts 镜像守卫钉死（比例漂移即红）。
 *
 * ⚠️ 浮层是**两层**：`.round-nav__panel`（命中盒，紧贴条列、无 overflow/margin）与
 * `.round-nav__list`（视觉盒 + 滚动容器）。命中盒与条列之间**必须零间隙**——视觉上的
 * 6px 留白由命中盒自身的 padding-right 提供（`background-clip` 不参与：命中盒不画视觉）。
 * 之所以不靠「过桥伪元素」补缝：桥只能覆盖条列高度，指针斜向跨行去浮层顶部/底部时仍会
 * 走出桥外断链，且恒存在的桥会给消息区右缘加一条 6px 的点击死区（HOST-NAV-1 四轮实测）。
 */
export const NAV_HEIGHT_RATIO = 0.5;

/**
 * 提取轮次预览文本：上屏文本 → 剥注入前缀 → 压缩空白成单行 → 截断
 *
 * 输入是上屏 .msg-body 的 textContent（渲染同源）；strip 让重放路径（带
 * 「当前打开文件：…」前缀）与运行时（无前缀）归一。空体返回空串（调用方
 * 据此给「（空输入）」占位）。
 */
export function extractPreview(raw: string): string {
  const single = stripInjectedContextPrefix(raw).replace(/\s+/g, ' ').trim();
  return single.length > PREVIEW_MAX ? `${single.slice(0, PREVIEW_MAX)}…` : single;
}

/**
 * 当前轮索引判定（纯函数，jsdom 可直接测）
 *
 * 判据 = 「可视顶下方 threshold 那条线落在哪一轮」：tops 按文档序升序，扫到第一个没越过
 * 该线的块即止。
 *
 * 🔴 **底部边界必须单独闭合（2026-10-22 真机缺陷，勿删）**：容器滚到底时 scrollTop 已达
 * `scrollHeight - clientHeight` 上限，最后一轮块的顶部**不可能**对齐视口顶（下方没有内容
 * 再把它顶上去）——于是阈值扫描永远够不到最后一轮，滚到底时高亮停在倒数第二轮（用户实测
 * 「已经显示最底部了，亮的却是倒数第二个点」）。滚动位置本身是唯一能表达「最后一轮已读到」
 * 的几何真值，故 `remaining ≤ eps` 时直接判最后一轮。
 *
 * @param tops      各锚点块 getBoundingClientRect().top（按文档序升序）
 * @param viewTop   滚动容器自身的 rect.top（可视顶基准）
 * @param threshold 块顶滚入可视顶该像素内即视为「已读过」
 * @param remaining 容器剩余可滚像素（`scrollHeight - scrollTop - clientHeight`）；
 *                  **必传**——做成可选会让新调用点漏传后静默退化回旧缺陷形态，
 *                  故由 TS 强制。无滚动容器的纯阈值场景传 `Infinity`。
 * @returns 当前轮索引；全部块仍在阈值之下（视口还在首块上方）返回 -1（无高亮）
 */
export function computeActiveIndex(
  tops: number[],
  viewTop: number,
  threshold: number,
  remaining: number,
): number {
  if (tops.length === 0) return -1;
  if (remaining <= ACTIVE_BOTTOM_EPS) return tops.length - 1;
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] - viewTop <= threshold) active = i;
    else break;
  }
  return active;
}

/**
 * 自适应压密（纯函数，jsdom 可直接测）
 *
 * 全量条 + 压密策略（用户拍板）：轮数再多也保留全部条（不截断，保住「全量地图 +
 * 一点即达」的形态），靠压缩条高与间隙适配可用高度；极端仍不足时由条列自身滚动
 * 兜底（CSS overflow，见 chatStyles 注释）。
 *
 * 压密次序 —— 先动间隙、后动条高（间隙视觉权重低，先牺牲）：①间隙压到 GAP_MIN；
 * ②仍不足再压条高（下限 BAR_MIN_H，保证每根仍可辨可点）。
 *
 * @param count  轮数（条数）
 * @param availH 条列可用高度（px）；count<=0 或 availH<=0（视口未就绪）返回宽松态默认
 * @returns 条高与间隙（px）
 */
export function computeDensity(count: number, availH: number): { barH: number; gap: number } {
  const relaxed = { barH: BAR_MAX_H, gap: GAP_MAX };
  if (count <= 0 || availH <= 0) return relaxed;
  // 宽松布局已装得下 → 不压（绝大多数会话命中此分支，条列保持 ChatGPT 同款呼吸感）
  if (count * BAR_MAX_H + (count - 1) * GAP_MAX <= availH) return relaxed;
  // ① 条高保持宽松，先把间隙压到下限之上
  if (count > 1) {
    const gapFit = (availH - count * BAR_MAX_H) / (count - 1);
    if (gapFit >= GAP_MIN) return { barH: BAR_MAX_H, gap: Math.floor(gapFit) };
  }
  // ② 间隙触底：再压条高（下限 BAR_MIN_H；仍不足 ⇒ 被条列滚动接住，不外溢）
  const barFit = count > 1 ? (availH - (count - 1) * GAP_MIN) / count : availH;
  return { barH: Math.max(BAR_MIN_H, Math.floor(barFit)), gap: GAP_MIN };
}

/**
 * 点击定位：把目标轮滚到容器可视顶附近，返回重算后的吸底真值
 *
 * 用 rect 差值累加到 scrollTop（不依赖 offsetParent 链——round-group 等中间层
 * 是否 positioned 不可信）。程序化赋值 scrollTop 是否派发 scroll 事件不确定
 * （jsdom 不派发），故返回前显式 trackScroll 重算吸底标记，调用方据此更新
 * 「一键到底」按钮显隐（对齐 jumpToBottom 的显式重算纪律，不复制吸底逻辑）。
 */
export function jumpToRound(messages: HTMLElement, target: HTMLElement): boolean {
  const containerTop = messages.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top;
  messages.scrollTop += targetTop - containerTop - JUMP_INSET;
  return trackScroll(messages);
}

/** 控制器句柄：sync = 结构变更/尺寸变更后重建与压密；refresh = 滚动后轻量刷高亮 */
export interface RoundNavController {
  sync(): void;
  refresh(): void;
}

/**
 * 重建签名：条数 + 全量预览文本拼接（分隔符防歧义）。
 *
 * ⚠️ **勿退回「条数 + 首尾块文本长」**：重放 / 分叉时条数与首尾长度都可能不变、仅中段
 * 文本不同，长度式签名会误判「未变」而跳过重建 ⇒ 条预览与浮层静默失效（读者信了、
 * 无测试会红类伤）。全量拼接对「任一预览变化」敏感，且锚 `.msg.user` = **仅用户输入**
 * （AI / error 气泡不在列，用户气泡在流式期文本不变）⇒ 不会因 AI 流式增长而每帧重建。
 */
function signatureOf(previews: string[]): string {
  return `${previews.length}\u0000${previews.join('\u0000')}`;
}

/**
 * 创建大纲导航条控制器并完成事件接线
 *
 * @param messages 滚动容器（#messages）
 * @param nav      静态外壳（#roundNav，含 `.round-nav__track` 条列 +
 *                 `.round-nav__panel` 命中盒 > `.round-nav__list` 视觉/滚动盒两层）
 * @returns 控制器句柄（chatView 把 sync 挂进 MutationObserver rAF 拍子与 resize，
 *          refresh 挂进 scroll）
 */
export function createRoundNav(messages: HTMLElement, nav: HTMLElement): RoundNavController {
  // fail-fast：外壳是静态骨架（生产 buildHtml 与测试夹具都有），缺失 = 夹具镜像失同步，
  // 立即炸出清晰错误而非让 null 一路传到 querySelector 报模糊 TypeError。
  // 守卫后重赋值常量：闭包窄化不跨函数传播（本项目 TS 口径），re-assign 保住非空类型
  const track0 = nav.querySelector<HTMLElement>('.round-nav__track');
  // 浮层两层：命中盒（.round-nav__panel）+ 视觉/滚动盒（.round-nav__list）。
  // 条目只进 list —— panel 必须保持「无 overflow、无横向 margin」，否则指针从条滑向
  // 浮层时会掉进一条没有元素接住的缝隙，hover 撤销、浮层当场闪退（见 chatStyles 注释）。
  const list0 = nav.querySelector<HTMLElement>('.round-nav__panel > .round-nav__list');
  if (!track0 || !list0) {
    throw new Error(
      '[roundNav] 外壳缺 .round-nav__track 或 .round-nav__panel>.round-nav__list：生产模板或测试夹具未同步',
    );
  }
  const track: HTMLElement = track0;
  const list: HTMLElement = list0;
  let lastSignature = '';
  /** 最近一次构建时的轮次气泡（点击定位按它寻址；与条列/浮层行同序） */
  let cachedWrappers: HTMLElement[] = [];
  /** 压密缓存键：轮数 + 预算 + 条高 + 间隙 任一变化才重写内联样式（防流式期每帧重写 DOM） */
  let lastMetricsKey = '';

  /**
   * 收集当前轮次锚点 + 各自预览文本（上屏文本 = 渲染同源，读 DOM 不另存状态）。
   *
   * 🔴 锚 **用户消息**（`.msg.user`），**不是** `.msg-wrapper`——`.msg-wrapper` 由 chatView
   * `append()` 的 else 分支创建，而该分支同时覆盖 **user 与 error** 两种 role
   * （签名 `role: 'user' | 'assistant' | 'error'`）。按 `.msg-wrapper` 收轮次会把 error
   * 气泡也当成一轮（多一根条、错误文案进预览、点击跳到错误气泡）；error 气泡是
   * `msg.error`、无 `.user` 类 ⇒ 锚 `.msg.user` 天然筛除，无需维护 role 白名单。
   * 定位仍取外层 `.msg-wrapper`（气泡壳，滚动落点更稳）；无壳者（降级渲染的
   * `.msg-user-fallback` 直挂消息流）回退锚自身。
   */
  function collect(): { wrappers: HTMLElement[]; previews: string[] } {
    const userMsgs = Array.from(messages.querySelectorAll<HTMLElement>('.msg.user'));
    const wrappers = userMsgs.map((m) => m.closest<HTMLElement>('.msg-wrapper') ?? m);
    const previews = userMsgs.map((m) => {
      const body = m.querySelector<HTMLElement>('.msg-body');
      return extractPreview(body?.textContent ?? '');
    });
    return { wrappers, previews };
  }

  /** 全量重建条列与浮层行（仅签名变化时真重建） */
  function rebuild(previews: string[]): void {
    track.textContent = '';
    list.textContent = '';
    previews.forEach((raw, i) => {
      const preview = raw || '（空输入）';
      // 条：视觉矩形由 CSS ::before 画（默认 2px 细线），触达区高于视觉条；条高由
      // applyMetrics 按压密结果内联下发（默认 --sp-5）。aria-label 让读屏与 title 都可读
      const bar = document.createElement('button');
      bar.type = 'button';
      bar.className = 'round-nav__bar';
      bar.dataset.index = String(i);
      bar.setAttribute('aria-label', `第 ${i + 1} 轮：${preview}`);
      bar.title = preview;
      track.appendChild(bar);
      // 浮层行：hover 容器显形，点击同条定位；文本节点构建防注入
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'round-nav__item';
      item.dataset.index = String(i);
      item.textContent = preview;
      list.appendChild(item);
    });
  }

  /**
   * 自适应压密应用：按视口高算预算 → 算条高/间隙 → 下发条列限高与条尺寸。
   *
   * 预算随视口变化而变，故**每次 sync 都调用**（resize 触发 sync 时即重算）；缓存键
   * 确保同预算同轮数下不重写内联样式（流式期 sync 高频，避免无谓 DOM 写）。
   * 镜像说明：CSS 侧 .round-nav__bar 高与 .round-nav__track gap 仍留令牌默认值，仅作
   * 「JS 未及接管前的宽松态兜底」；接管后**唯一真源 = 本函数下发值**（BAR_MAX_H /
   * GAP_MAX 与令牌同值，由 roundNav.test.ts 镜像守卫钉死——漂移即红，不再靠人肉核对）。
   */
  function applyMetrics(count: number): void {
    const win = messages.ownerDocument.defaultView;
    const budget = Math.round((win?.innerHeight ?? 0) * NAV_HEIGHT_RATIO);
    const { barH, gap } = computeDensity(count, budget);
    const key = `${count}:${budget}:${barH}:${gap}`;
    if (key === lastMetricsKey) return;
    lastMetricsKey = key;
    // 条列限高：唯一高度上限真源（预算 0 = 视口未就绪时不设，交还 CSS 默认态）
    if (budget > 0) track.style.maxHeight = `${budget}px`;
    track.style.gap = `${gap}px`;
    track.querySelectorAll<HTMLElement>('.round-nav__bar').forEach((bar) => {
      bar.style.height = `${barH}px`;
    });
  }

  /** 结构/尺寸变更后：重建裁决 + 压密 + 高亮 */
  function sync(): void {
    const { wrappers, previews } = collect();
    const signature = signatureOf(previews);
    cachedWrappers = wrappers;
    // 显隐裁决：不足两轮（无导航价值）或容器不可滚动（全在视口内）⇒ 整条隐藏
    const scrollable = messages.scrollHeight > messages.clientHeight;
    nav.hidden = wrappers.length < 2 || !scrollable;
    if (!nav.hidden && signature !== lastSignature) {
      lastSignature = signature;
      rebuild(previews);
    }
    // 压密总会跑：resize 改变预算但轮数/签名不变时，仍需按新预算重排条列
    applyMetrics(wrappers.length);
    if (!nav.hidden) refresh();
  }

  /** 滚动后轻量刷新：只读几何判当前轮、切高亮类（不重建条列） */
  function refresh(): void {
    const bars = track.querySelectorAll<HTMLElement>('.round-nav__bar');
    if (bars.length === 0) return;
    const viewTop = messages.getBoundingClientRect().top;
    // tops 与 bars 同序（同一批 wrapper 的块顶）；jsdom 恒 0 ⇒ 全部命中阈值 0 号位——
    // 真机才有效，测试用例经打桩或纯函数覆盖
    const tops = Array.from(bars).map((bar) => {
      const wrapper = cachedWrappers[Number(bar.dataset.index)];
      return wrapper?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    });
    // 剩余可滚像素：**现算几何真值**，不读 trackScroll 的吸底标记——吸底是「用户意图」
    // （内容高度变更后可能与实际位置脱节，见 scrollToBottom.ts 头部注释），高亮必须跟
    // 实际滚动位置走。三个属性都是只读，与上面 rect 读取同处一次 layout 之后，不增 reflow。
    const remaining = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    const active = computeActiveIndex(tops, viewTop, ACTIVE_THRESHOLD, remaining);
    bars.forEach((bar, i) => bar.classList.toggle('is-active', i === active));
    list.querySelectorAll<HTMLElement>('.round-nav__item').forEach((item, i) => {
      item.classList.toggle('is-active', i === active);
    });
  }

  // 点击委托（条与浮层行共用一个监听）：按 data-index 寻址定位；
  // 定位后按返回的吸底真值同步「一键到底」按钮（与 scroll 监听同一显隐判据）
  nav.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>(
      '.round-nav__bar, .round-nav__item',
    );
    if (!btn) return;
    const wrapper = cachedWrappers[Number(btn.dataset.index)];
    if (!wrapper) return;
    const atBottom = jumpToRound(messages, wrapper);
    const scrollToBottomBtn = nav.ownerDocument.getElementById('scrollToBottomBtn');
    if (scrollToBottomBtn) scrollToBottomBtn.hidden = atBottom;
    refresh();
  });

  return { sync, refresh };
}
