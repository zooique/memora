/**
 * 会话大纲导航条（HOST-NAV-1）— 右缘按轮锚点 + hover 预览 + 点击定位
 *
 * 形态（ChatGPT 同款范式，台账 HOST-NAV-1）：对话流右缘一列小横条，每轮用户输入一根；
 * 视口内当前轮加粗高亮；hover 弹浮层列各轮用户输入原文预览；点击滚动定位到对应轮。
 * 平时几乎隐形（不滚动/不足两轮时整条隐藏），不占布局。
 *
 * SSOT 决策：
 *  - **锚定对象 = 用户气泡 .msg-wrapper，不依赖 roundId**——运行时发送时刻还没有
 *    roundId（meta/chunk 到达才回填），重放路径才有。大纲条只做「定位 + 预览 + 高亮」，
 *    全部可由气泡 DOM 位置与上屏文本表达，绕开「运行时无 id」的时序问题。
 *  - **预览文本 = 上屏 .msg-body 文本过 stripInjectedContextPrefix**——重放（读落盘
 *    Round，带注入前缀）与运行时（回显原始 input，无前缀）两路上屏形态不同，经同一
 *    纯函数归一；不另从 round-store 拉第二套文本（防运行时与重放两套口径）。
 *  - **重建时机与渲染同源**：调用方（chatView）把 sync 挂进既有 MutationObserver 的
 *    rAF 拍子（吸底同一通道同一节拍），不在各渲染路径埋点；内部用签名比对
 *    （条数 + 首尾块文本长）防流式期每帧重建。
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

/** 浮层预览截断长度（字符）：浮层行宽有限，超长输入截断即可辨认 */
const PREVIEW_MAX = 60;

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
 * @param tops    各锚点块 getBoundingClientRect().top（按文档序升序）
 * @param viewTop 滚动容器自身的 rect.top（可视顶基准）
 * @param threshold 块顶滚入可视顶该像素内即视为「已读过」
 * @returns 当前轮索引；全部块仍在阈值之下（视口还在首块上方）返回 -1（无高亮）
 */
export function computeActiveIndex(
  tops: number[],
  viewTop: number,
  threshold = ACTIVE_THRESHOLD,
): number {
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] - viewTop <= threshold) active = i;
    else break;
  }
  return active;
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

/** 控制器句柄：sync = 结构变更后全量重建（MutationObserver 拍子）；refresh = 滚动后轻量刷高亮 */
export interface RoundNavController {
  sync(): void;
  refresh(): void;
}

/** 重建签名：条数 + 首尾块文本长。数量不变且尾块不再增长 ⇒ 内容没变，跳过重建 */
function signatureOf(previews: string[]): string {
  const first = previews[0]?.length ?? -1;
  const last = previews[previews.length - 1]?.length ?? -1;
  return `${previews.length}:${first}:${last}`;
}

/**
 * 创建大纲导航条控制器并完成事件接线
 *
 * @param messages 滚动容器（#messages）
 * @param nav      静态外壳（#roundNav，含 .round-nav__track 条列 + .round-nav__panel 浮层）
 * @returns 控制器句柄（chatView 把 sync/refresh 分别挂进 MutationObserver rAF 拍子与 scroll 监听）
 */
export function createRoundNav(messages: HTMLElement, nav: HTMLElement): RoundNavController {
  // fail-fast：外壳是静态骨架（生产 buildHtml 与测试夹具都有），缺失 = 夹具镜像失同步，
  // 立即炸出清晰错误而非让 null 一路传到 querySelector 报模糊 TypeError。
  // 守卫后重赋值常量：闭包窄化不跨函数传播（本项目 TS 口径），re-assign 保住非空类型
  const track0 = nav.querySelector<HTMLElement>('.round-nav__track');
  const panel0 = nav.querySelector<HTMLElement>('.round-nav__panel');
  if (!track0 || !panel0) {
    throw new Error(
      '[roundNav] 外壳缺 .round-nav__track/.round-nav__panel：生产模板或测试夹具未同步',
    );
  }
  const track: HTMLElement = track0;
  const panel: HTMLElement = panel0;
  let lastSignature = '';
  /** 最近一次构建时的轮次气泡（点击定位按它寻址；与条列/浮层行同序） */
  let cachedWrappers: HTMLElement[] = [];

  /** 收集当前轮次气泡 + 各自预览文本（上屏文本 = 渲染同源，读 DOM 不另存状态） */
  function collect(): { wrappers: HTMLElement[]; previews: string[] } {
    const wrappers = Array.from(messages.querySelectorAll<HTMLElement>('.msg-wrapper'));
    const previews = wrappers.map((w) => {
      const body = w.querySelector<HTMLElement>('.msg-body');
      return extractPreview(body?.textContent ?? '');
    });
    return { wrappers, previews };
  }

  /** 全量重建条列与浮层行（仅签名变化时真重建；流式期同帧多次调用被签名挡住） */
  function sync(): void {
    const { wrappers, previews } = collect();
    const signature = signatureOf(previews);
    cachedWrappers = wrappers;
    // 显隐裁决：不足两轮（无导航价值）或容器不可滚动（全在视口内）⇒ 整条隐藏
    const scrollable = messages.scrollHeight > messages.clientHeight;
    nav.hidden = wrappers.length < 2 || !scrollable;
    if (nav.hidden || signature === lastSignature) return;
    lastSignature = signature;
    track.textContent = '';
    panel.textContent = '';
    wrappers.forEach((_, i) => {
      const preview = previews[i] || '（空输入）';
      // 条：视觉 2px 横线，触达区由 CSS 撑高；aria-label 让读屏与 title 都可读
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
      panel.appendChild(item);
    });
    refresh();
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
    const active = computeActiveIndex(tops, viewTop);
    bars.forEach((bar, i) => bar.classList.toggle('is-active', i === active));
    panel.querySelectorAll<HTMLElement>('.round-nav__item').forEach((item, i) => {
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
