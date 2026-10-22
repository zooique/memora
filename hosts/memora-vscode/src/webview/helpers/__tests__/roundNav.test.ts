/**
 * 会话大纲导航条（HOST-NAV-1）测试 — helpers/roundNav.ts
 *
 * 分层覆盖：
 *  - 纯函数直测（无 DOM）：extractPreview（预览归一）/ computeActiveIndex（当前轮判定）
 *  - DOM 集成（jsdom）：createRoundNav 控制器——条列构建、签名防重、显隐裁决、
 *    点击定位、注入前缀剥离、fail-fast 守卫
 *
 * jsdom 无布局：scrollHeight / scrollTop / getBoundingClientRect 按需打桩
 * （对齐 chatView.test.ts stubScroll 既有纪律）。
 *
 * 🔴 **未打桩时 `scrollHeight === clientHeight === 0` ⇒ remaining = 0 ⇒ 必走贴底分支**
 * （computeActiveIndex 判末轮）。所以「不打桩也断言到尾条 is-active」的用例**证不了阈值
 * 扫描**——它走的是贴底那条路。凡要验「块顶阈值判定」的用例，`remaining` 必须显式给大值
 * （纯函数传 `NO_SCROLL` / 集成用例 stubScrollBox 给足剩余高度），否则得到的是假绿。
 */

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInjectedContextEnvelope, buildDocContextBlock } from '../docContext.js';
import {
  BAR_MAX_H,
  GAP_MAX,
  NAV_HEIGHT_RATIO,
  computeActiveIndex,
  computeDensity,
  createRoundNav,
  extractPreview,
  jumpToRound,
} from '../roundNav.js';

/** jsdom 默认视口高（测试内覆写后须还原，防跨用例污染） */
const ORIGINAL_INNER_HEIGHT = window.innerHeight;

/** 覆写视口高（压密预算随它变化） */
function stubInnerHeight(h: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

/** 还原视口高（用例收尾用） */
function restoreInnerHeight(): void {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: ORIGINAL_INNER_HEIGHT,
  });
}

/** 打桩元素几何（configurable 覆写，测后可还原） */
function stubRect(el: Element, top: number): void {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
}

/** 打桩滚动容器三件套（scrollHeight / clientHeight / scrollTop 读写闭包） */
function stubScrollBox(
  el: HTMLElement,
  box: { scrollHeight: number; clientHeight: number; scrollTop?: number },
): {
  scrollTop: number;
} {
  const state = { scrollTop: box.scrollTop ?? 0 };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => {
      state.scrollTop = v;
    },
  });
  return state;
}

/** 建 #roundNav 外壳（与生产模板同构） */
function mountShell(parent: HTMLElement): HTMLElement {
  const nav = document.createElement('div');
  nav.id = 'roundNav';
  nav.className = 'round-nav';
  nav.hidden = true;
  nav.innerHTML =
    '<div class="round-nav__track"></div>' +
    '<div class="round-nav__panel"><div class="round-nav__list"></div></div>';
  parent.appendChild(nav);
  return nav;
}

/** 建一个用户轮次气泡（与 append() 的 user 分支同构：wrapper > msg.user > msg-body） */
function mountUserBubble(messages: HTMLElement, text: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper';
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  bubble.appendChild(body);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  return wrapper;
}

/**
 * 建一个 error 气泡（与 append() 的 else 分支同构：wrapper > msg.error > msg-body）。
 *
 * 🔴 与用户气泡**共用** `.msg-wrapper` 外壳（append 的 else 分支覆盖 user|error 两 role），
 * 但消息类为 `msg.error`（无 `.user`）——用作「非轮次不得入列」的判据样本。
 */
function mountErrorBubble(messages: HTMLElement, text: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper';
  const bubble = document.createElement('div');
  bubble.className = 'msg error';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  bubble.appendChild(body);
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  return wrapper;
}

describe('extractPreview（预览归一纯函数）', () => {
  it('剥掉宿主注入信封前缀，还原用户请求原文（重放路径形态）', () => {
    // 写入侧对偶构造：不硬编码前缀字符串，防前缀格式演化时测试失真
    const envelope = buildInjectedContextEnvelope(
      [buildDocContextBlock('文档正文……')],
      '帮我把第三节改短',
    );
    expect(extractPreview(envelope)).toBe('帮我把第三节改短');
  });

  it('多行多空格压缩成单行（气泡 textContent 保留换行，预览单行化）', () => {
    expect(extractPreview('第一行\n\n  第二行   文本')).toBe('第一行 第二行 文本');
  });

  it('超长截断到 60 字符加省略号', () => {
    const long = '长'.repeat(80);
    const out = extractPreview(long);
    expect(out.length).toBe(61); // 60 字符 + …
    expect(out.endsWith('…')).toBe(true);
  });

  it('无注入前缀的普通消息原样（仅单行化）', () => {
    expect(extractPreview('普通输入')).toBe('普通输入');
  });
});

describe('computeActiveIndex（当前轮判定纯函数）', () => {
  /** 无滚动余量（不贴底）：只走块顶阈值判定的形态 */
  const NO_SCROLL = Number.POSITIVE_INFINITY;

  it('块顶滚入阈值内的最后一个为当前轮', () => {
    // tops 按文档序升序；10/50 已入阈值（96），120 未入 → 当前 = 1
    expect(computeActiveIndex([10, 50, 120], 0, 96, NO_SCROLL)).toBe(1);
  });

  it('全部块仍在视口顶下方阈值之外 → -1（无高亮）', () => {
    expect(computeActiveIndex([200, 300], 0, 96, NO_SCROLL)).toBe(-1);
  });

  it('全部块顶部越过阈值 → 最后一个为当前轮（纯阈值形态；真机靠 remaining 才能到达）', () => {
    expect(computeActiveIndex([10, 20, 30], 0, 96, NO_SCROLL)).toBe(2);
  });

  it('阈值由调用方给定（生产值 96，可覆写）', () => {
    expect(computeActiveIndex([150], 0, 200, NO_SCROLL)).toBe(0);
  });

  /**
   * 贴底闭合（2026-10-22 真机缺陷：滚到最底部，亮的却是倒数第二个点）
   *
   * 真机形态：clientHeight 400、块顶距视口顶 0 / 50 / **150**（末块高 250 撑到视口底）——
   * 因为 scrollTop 已达上限，末块顶**不可能**再上移。缺了 remaining 这条，阈值(96)扫描
   * 只能到倒数第二个，最后一根条永远不亮；其余轮次一一对应正常（用户原话）。
   */
  it('贴底（剩余可滚 ≤ eps）→ 最后一轮为当前轮，即使其块顶远未进入阈值', () => {
    expect(computeActiveIndex([0, 50, 150], 0, 96, 250)).toBe(1); // 未贴底：阈值扫描原行为
    expect(computeActiveIndex([0, 50, 150], 0, 96, 0)).toBe(2); // 贴底：末轮
  });

  it('贴底容差只吸收亚像素残差：eps 内算贴底，eps 外仍走阈值扫描（防提前跳末轮）', () => {
    expect(computeActiveIndex([0, 50, 150], 0, 96, 2)).toBe(2);
    expect(computeActiveIndex([0, 50, 150], 0, 96, 3)).toBe(1);
  });

  it('无块时即使贴底也返回 -1（不越界取尾）', () => {
    expect(computeActiveIndex([], 0, 96, 0)).toBe(-1);
  });
});

describe('computeDensity（自适应压密纯函数）', () => {
  it('未就绪（轮数 0 或可用高 0）→ 宽松态默认，不误压', () => {
    expect(computeDensity(0, 500)).toEqual({ barH: 12, gap: 6 });
    expect(computeDensity(5, 0)).toEqual({ barH: 12, gap: 6 });
  });

  it('宽松布局装得下 → 保持宽松（绝大多数会话形态）', () => {
    // 5 轮宽松总高 = 5*12 + 4*6 = 84 ≤ 1000
    expect(computeDensity(5, 1000)).toEqual({ barH: 12, gap: 6 });
  });

  it('第一步：条高保持，先压间隙到下限之上', () => {
    // 10 轮宽松总高 174 > 150；gapFit = (150-120)/9 = 3.33 → 3 → {12,3}
    expect(computeDensity(10, 150)).toEqual({ barH: 12, gap: 3 });
  });

  it('第二步：间隙触底后再压条高（下限之上）', () => {
    // 10 轮 gapFit < 1 → barFit = (100-9)/10 = 9.1 → 9 → {9,1}
    expect(computeDensity(10, 100)).toEqual({ barH: 9, gap: 1 });
  });

  it('单轮且空间极小：直接压下条高（不过间隙分支）', () => {
    expect(computeDensity(1, 5)).toEqual({ barH: 5, gap: 1 });
  });

  it('极端轮数：压到双下限（barH=3 / gap=1），余量交条列滚动兜底', () => {
    // 100 轮 gapFit < 1 → barFit = (150-99)/100 = 0.51 → 0 → 取下限 3 → {3,1}
    expect(computeDensity(100, 150)).toEqual({ barH: 3, gap: 1 });
  });
});

describe('jumpToRound（点击定位）', () => {
  it('按 rect 差值把目标块顶滚到可视顶 inset 处，并显式重算吸底标记', () => {
    const messages = document.createElement('div');
    document.body.appendChild(messages);
    const target = document.createElement('div');
    messages.appendChild(target);
    stubRect(messages, 0); // 容器可视顶 = 视口 0
    stubRect(target, 300); // 目标块顶在视口 300
    const state = stubScrollBox(messages, {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
    });
    // 期望 scrollTop += 300 - 0 - 12 = 288；吸底 = 2000 - 288 - 400 = 1312 > 48 → false
    const atBottom = jumpToRound(messages, target);
    expect(state.scrollTop).toBe(288);
    expect(atBottom).toBe(false);
    document.body.innerHTML = '';
  });

  it('定位到接近底部时吸底真值为 true（调用方据此隐「一键到底」）', () => {
    const messages = document.createElement('div');
    document.body.appendChild(messages);
    const target = document.createElement('div');
    messages.appendChild(target);
    stubRect(messages, 0);
    stubRect(target, 1600); // scrollTop += 1600 - 12 = 1588
    stubScrollBox(messages, {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
    }); // 2000 - 1588 - 400 = 12 ≤ 48 → 吸底
    expect(jumpToRound(messages, target)).toBe(true);
    document.body.innerHTML = '';
  });
});

describe('createRoundNav（控制器集成）', () => {
  let root: HTMLElement;
  let messages: HTMLElement;
  let nav: HTMLElement;
  let track: HTMLElement;
  let list: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.body;
    messages = document.createElement('div');
    messages.id = 'messages';
    root.appendChild(messages);
    nav = mountShell(root);
    track = nav.querySelector('.round-nav__track') as HTMLElement;
    list = nav.querySelector('.round-nav__panel > .round-nav__list') as HTMLElement;
    // 一键到底按钮：点击定位后同步显隐（生产接线契约）
    const btn = document.createElement('button');
    btn.id = 'scrollToBottomBtn';
    root.appendChild(btn);
  });

  afterEach(() => {
    restoreInnerHeight();
  });

  it('fail-fast：外壳缺条列/浮层容器时抛清晰错误（夹具镜像失同步立即暴露）', () => {
    const broken = document.createElement('div');
    root.appendChild(broken);
    expect(() => createRoundNav(messages, broken)).toThrow(/round-nav__track/);
  });

  it('fail-fast：浮层缺视觉盒 .round-nav__list 时抛清晰错误（两层结构不可退化为单层）', () => {
    // 夹具若退回「panel 直接装条目」的旧单层形态，条目会落进一个无 overflow 的盒子：
    // jsdom 看不出来、真机就是浮层不出滚动且边框/阴影丢失 ⇒ 显式炸在初始化
    const single = document.createElement('div');
    single.innerHTML = '<div class="round-nav__track"></div><div class="round-nav__panel"></div>';
    root.appendChild(single);
    expect(() => createRoundNav(messages, single)).toThrow(/round-nav__list/);
  });

  it('可滚动且 ≥2 轮 → 显形并按轮构建条列与浮层行（aria-label/预览同源）', () => {
    mountUserBubble(messages, '第一轮输入');
    mountUserBubble(messages, '第二轮\n多行输入');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    expect(nav.hidden).toBe(false);
    const bars = track.querySelectorAll('.round-nav__bar');
    const items = list.querySelectorAll('.round-nav__item');
    // 条目父节点必须是视觉盒本身（挂到命中盒上则滚动/边框全失效，真机才看得出来）
    expect(items[0]!.parentElement).toBe(list);
    expect(bars.length).toBe(2);
    expect(items.length).toBe(2);
    // 预览 = 上屏文本单行化；aria-label 与 title 同源
    expect((bars[1] as HTMLElement).title).toBe('第二轮 多行输入');
    expect(bars[1].getAttribute('aria-label')).toBe('第 2 轮：第二轮 多行输入');
    expect(items[1].textContent).toBe('第二轮 多行输入');
  });

  /**
   * 贴底高亮（2026-10-22 真机缺陷回归项：到底后亮的是倒数第二个点）
   *
   * 真机几何：clientHeight 400 / scrollHeight 1200 / scrollTop 已到上限 800 ⇒ remaining=0。
   * 三块块顶相对视口 -800 / -100 / **150**：末块顶距视口顶 150 > 阈值 96，阈值扫描只能到
   * 第 2 轮 ⇒ 用户看到「已显示最底部，亮的却是倒数第二个」。前两轮正常对应（同一扫描）。
   */
  it('滚到最底部 → 高亮最后一轮（不停在倒数第二轮）', () => {
    const w1 = mountUserBubble(messages, '第一轮');
    const w2 = mountUserBubble(messages, '第二轮');
    const w3 = mountUserBubble(messages, '第三轮');
    stubScrollBox(messages, { scrollHeight: 1200, clientHeight: 400, scrollTop: 800 });
    stubRect(messages, 0);
    stubRect(w1, -800);
    stubRect(w2, -100);
    stubRect(w3, 150);
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bars = track.querySelectorAll<HTMLElement>('.round-nav__bar');
    const items = list.querySelectorAll<HTMLElement>('.round-nav__item');
    expect(bars.length).toBe(3);
    // 条与浮层行同判（两套高亮真源漂移 = 一条亮一条不亮）
    expect(bars[2]!.classList.contains('is-active')).toBe(true);
    expect(items[2]!.classList.contains('is-active')).toBe(true);
    expect(bars[1]!.classList.contains('is-active')).toBe(false);
  });

  it('未贴底时仍按块顶阈值判定（不因「接近底部」提前跳到最后一轮）', () => {
    const w1 = mountUserBubble(messages, '第一轮');
    const w2 = mountUserBubble(messages, '第二轮');
    const w3 = mountUserBubble(messages, '第三轮');
    // scrollTop 400 ⇒ remaining = 1200 - 400 - 400 = 400 ≫ eps
    stubScrollBox(messages, { scrollHeight: 1200, clientHeight: 400, scrollTop: 400 });
    stubRect(messages, 0);
    stubRect(w1, -400);
    stubRect(w2, 0);
    stubRect(w3, 300);
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bars = track.querySelectorAll<HTMLElement>('.round-nav__bar');
    expect(bars[1]!.classList.contains('is-active')).toBe(true);
    expect(bars[2]!.classList.contains('is-active')).toBe(false);
  });

  it('error 气泡（.msg-wrapper 但非 .msg.user）不计入轮次——不污染条列与预览', () => {
    mountUserBubble(messages, '第一轮');
    mountErrorBubble(messages, '出错了：连接超时');
    mountUserBubble(messages, '第二轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bars = track.querySelectorAll('.round-nav__bar');
    // 3 个 .msg-wrapper（2 user + 1 error），但仅 2 轮用户输入 → 只应 2 根条
    expect(bars.length).toBe(2);
    expect((bars[0] as HTMLElement).title).toBe('第一轮');
    expect((bars[1] as HTMLElement).title).toBe('第二轮');
  });

  it('不足两轮或容器不可滚动 → 整条隐藏（平时几乎隐形，不占布局）', () => {
    mountUserBubble(messages, '唯一一轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    expect(nav.hidden).toBe(true); // 1 轮：无导航价值
    mountUserBubble(messages, '第二轮');
    sync();
    expect(nav.hidden).toBe(false); // 2 轮 + 可滚动 → 显形
    Object.defineProperty(messages, 'scrollHeight', {
      configurable: true,
      get: () => 400, // 与 clientHeight 相等 = 不可滚动
    });
    sync();
    expect(nav.hidden).toBe(true);
  });

  it('签名未变时跳过重建（流式期每帧 sync 不重建 DOM）；尾块文本增长则重建', () => {
    mountUserBubble(messages, '第一轮');
    mountUserBubble(messages, '第二轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const barBefore = track.querySelector('.round-nav__bar');
    sync(); // 同 DOM 同内容 → 签名命中 → 引用不变
    expect(track.querySelector('.round-nav__bar')).toBe(barBefore);
    // 尾块文本增长（流式期用户气泡不会长，但重放/重建路径内容会变）→ 签名变 → 重建
    const lastBody = messages.querySelectorAll('.msg-body')[1] as HTMLElement;
    lastBody.textContent = '第二轮内容变长了';
    sync();
    expect(track.querySelector('.round-nav__bar')).not.toBe(barBefore);
    expect(track.querySelectorAll('.round-nav__bar').length).toBe(2);
  });

  it('点击条定位到对应轮：scrollTop 按目标轮寻址，并同步一键到底按钮显隐', () => {
    const w0 = mountUserBubble(messages, '第一轮');
    const w1 = mountUserBubble(messages, '第二轮');
    stubRect(messages, 0);
    stubRect(w0, 0);
    stubRect(w1, 1200); // 第 2 轮块顶在视口 1200
    stubScrollBox(messages, { scrollHeight: 3000, clientHeight: 400, scrollTop: 0 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bar1 = track.querySelectorAll('.round-nav__bar')[1] as HTMLElement;
    bar1.click();
    // scrollTop += 1200 - 0 - 12 = 1188；3000 - 1188 - 400 = 1412 > 48 → 不吸底 → 按钮显示
    const btn = document.getElementById('scrollToBottomBtn') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
  });

  it('注入前缀在上屏文本中的轮次（重放形态）预览被剥离，只露用户请求', () => {
    const envelope = buildInjectedContextEnvelope(
      [buildDocContextBlock('文档正文')],
      '重放轮的用户请求',
    );
    mountUserBubble(messages, envelope);
    mountUserBubble(messages, '第二轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bar0 = track.querySelectorAll('.round-nav__bar')[0] as HTMLElement;
    expect(bar0.title).toBe('重放轮的用户请求');
  });

  it('jsdom 未打桩 rect（恒 0）下 sync 后尾条高亮（几何表现由真机验收兜）', () => {
    mountUserBubble(messages, '第一轮');
    mountUserBubble(messages, '第二轮');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const bars = track.querySelectorAll('.round-nav__bar');
    expect(bars[1].classList.contains('is-active')).toBe(true);
    expect(bars[0].classList.contains('is-active')).toBe(false);
  });

  it('指纹全量：仅中段预览变化也重建（堵重放/分叉「条数+首尾长」静默失效）', () => {
    mountUserBubble(messages, 'AAA');
    mountUserBubble(messages, 'BBB');
    mountUserBubble(messages, 'CCC');
    stubScrollBox(messages, { scrollHeight: 2000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    const barBefore = track.querySelector('.round-nav__bar');
    // 条数（3）与首尾长度（3/3）均不变，仅中段文本换字（同长度）——旧「首尾长」指纹会误判未变
    const midBody = messages.querySelectorAll('.msg-body')[1] as HTMLElement;
    midBody.textContent = 'ZZZ';
    sync();
    expect(track.querySelector('.round-nav__bar')).not.toBe(barBefore);
    expect((track.querySelectorAll('.round-nav__bar')[1] as HTMLElement).title).toBe('ZZZ');
  });

  it('压密接线：按视口高预算下发条列限高/间隙/条高（resize 复用 sync 重算）', () => {
    stubInnerHeight(300); // 预算 = 300 * 0.5 = 150
    for (let i = 0; i < 10; i++) mountUserBubble(messages, `第 ${i + 1} 轮`);
    stubScrollBox(messages, { scrollHeight: 4000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    // computeDensity(10, 150) = { barH: 12, gap: 3 }
    expect(track.style.maxHeight).toBe('150px');
    expect(track.style.gap).toBe('3px');
    expect((track.querySelector('.round-nav__bar') as HTMLElement).style.height).toBe('12px');
    // 缩小视口 → 预算变小 → 重算压密（模拟 resize）
    stubInnerHeight(80); // 预算 = 40 → barFit = (40-9)/10 = 3.1 → 取下限 3
    sync();
    expect(track.style.maxHeight).toBe('40px');
    expect((track.querySelector('.round-nav__bar') as HTMLElement).style.height).toBe('3px');
  });

  it('极端轮数：全量条不截断，压到双下限（gap=1 / barH=3）交条列滚动兜底', () => {
    stubInnerHeight(300);
    for (let i = 0; i < 100; i++) mountUserBubble(messages, `第 ${i + 1} 轮`);
    stubScrollBox(messages, { scrollHeight: 9000, clientHeight: 400 });
    const { sync } = createRoundNav(messages, nav);
    sync();
    expect(track.querySelectorAll('.round-nav__bar').length).toBe(100);
    expect(track.style.gap).toBe('1px');
    expect((track.querySelector('.round-nav__bar') as HTMLElement).style.height).toBe('3px');
  });
});

/**
 * 压密常量镜像守卫（JS ↔ 令牌，防「已登记未闭合」的静默漂移）
 *
 * roundNav.ts 的 BAR_MAX_H / GAP_MAX / NAV_HEIGHT_RATIO 是「JS 侧数值镜像」——须与令牌
 * --sp-5 / --sp-2 及浮层 `max-height:50vh` 同值。此前该镜像只在注释里写「改一处须核另一处」，
 * **无任何测试会红**（本轮审计实锤的「镜像伤」）⇒ 本守卫把镜像钉成强制：漂移即红。
 * 读源码文本比对（与 tokensClosure 同法：镜像两侧涉及 CSS 文本常量，类型系统看不见）。
 */
describe('压密常量镜像守卫（JS ↔ 令牌/浮层 max-height）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');
  const tokensText = read('../../styles/tokens.ts');
  const chatStylesText = read('../../styles/chatStyles.ts');
  /** 取令牌 px 定义值（--name: Npx）；缺失即抛，防「提取失效→假绿」 */
  const tokenPx = (name: string): number => {
    const m = new RegExp(`--${name}\\s*:\\s*(\\d+)px`).exec(tokensText);
    if (!m) throw new Error(`令牌 --${name} 未找到（镜像守卫无法比对）`);
    return Number(m[1]);
  };

  it('BAR_MAX_H / GAP_MAX 必须等于令牌 --sp-5 / --sp-2', () => {
    expect(BAR_MAX_H).toBe(tokenPx('sp-5'));
    expect(GAP_MAX).toBe(tokenPx('sp-2'));
  });

  it('NAV_HEIGHT_RATIO 必须与浮层视觉盒 .round-nav__list 的 max-height(50vh) 同判', () => {
    // 四轮结构拆分后限高从 panel 挪到 list（panel 不滚动），镜像仍须与 JS 比例同判
    const m = /\.round-nav__list\s*\{[\s\S]*?max-height:\s*(\d+)vh/.exec(chatStylesText);
    expect(m, '.round-nav__list 的 max-height 未找到').not.toBeNull();
    expect(Math.round(NAV_HEIGHT_RATIO * 100)).toBe(Number(m![1]));
  });

  /**
   * 浮层两层结构守卫（2026-10-22 真机反馈：鼠标从条移向浮层时穿缝 hover 断链、浮层闪退）
   *
   * 契约三条，任一破坏都会让「看起来有 6px 间隙、实际上零缝」失效：
   *   ① 命中盒 `.round-nav__panel` **不得有横向 margin / overflow**——margin 会把指针必经
   *      的那一段变成无主缝隙（hover 当场撤销），overflow 会裁掉视觉盒的阴影；
   *   ② 视觉间隙唯一来源 = 命中盒自身的 `padding-right: var(--sp-2)`（盒内留白）；
   *   ③ 视觉盒 `.round-nav__list` 承载限高 + 滚动（成对：只删限高 = 被裁内容永不可达）。
   * jsdom 无 hit-test，只能读生产样式源码钉死（与上方镜像守卫同法）。
   */
  it('浮层两层结构：命中盒零 margin/overflow + 间隙走 padding + 视觉盒限高滚动成对', () => {
    const ruleBody = (sel: string): string => {
      const m = new RegExp(`${sel}\\s*\\{([\\s\\S]*?)\\}`).exec(chatStylesText);
      expect(m, `${sel} 规则块未找到（提取失效→空串恒过）`).not.toBeNull();
      return (m?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    };
    const panelBody = ruleBody('\\.round-nav__panel');
    // ① 命中盒必须紧贴条列
    expect(panelBody, '命中盒出现横向 margin —— 缝隙回归，浮层会闪退').not.toMatch(
      /margin(-left|-right)?\s*:\s*[^;]*[1-9]/,
    );
    expect(panelBody, '命中盒不得自带 overflow（会裁掉视觉盒阴影）').not.toMatch(/overflow/);
    // ② 视觉间隙的唯一来源
    expect(panelBody, '命中盒缺 padding-right: var(--sp-2)：视觉间隙会变成 0').toMatch(
      /padding-right:\s*var\(--sp-2\b/,
    );
    // ③ 视觉盒承载视觉与滚动
    const listBody = ruleBody('\\.round-nav__list');
    expect(listBody, '视觉盒缺 max-height（限高缺失→浮层可无限长）').toMatch(/max-height:\s*\d+vh/);
    expect(listBody, '视觉盒缺 overflow-y: auto（与限高成对，不能只留限高）').toMatch(
      /overflow-y:\s*auto/,
    );
    expect(listBody, '视觉盒缺边框：浮层失去可辨识外观').toMatch(/border:\s*var\(--line-input\)/);
    expect(listBody, '视觉盒缺背景').toMatch(/background:\s*var\(--surface-input/);
    expect(listBody, '视觉盒缺阴影').toMatch(/box-shadow:\s*var\(--shadow-card/);
  });
});
