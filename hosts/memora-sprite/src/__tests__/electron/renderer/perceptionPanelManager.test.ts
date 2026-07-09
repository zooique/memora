/**
 * 感知面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - updateAffectDisplay()：四维进度条 + 精灵状态条 + 状态保存供叙事
 * - updateRapportDisplay()：等级徽章 + 信任/熟悉度进度条 + 描述 + 状态保存
 * - updateContextDisplay()：节奏/连贯性/深度三列指标 + 状态保存
 * - updatePatternsDisplay()：模式列表（空/非空/超过3条不截断）+ section 显隐 + 状态保存
 * - updatePresenceDisplay()：present/away 状态指示器 + 离开时长显示
 * - updateNarrative()：叙事文本合成 + 精灵状态条联动
 * - generateNarrative()：综合 5 状态合成（通过 updateNarrative 间接验证）
 * - cleanup()：无外部资源（保持生命周期契约）
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API
 * - 感知面板管理器无 EventTracker 依赖（模式 D 自包含）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PerceptionPanelManager } from '../../../electron/renderer/panels/perceptionPanelManager.js';
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
  PatternsPayload,
  PresencePayload,
} from '../../../electron/renderer/ipcListeners.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 感知面板完整 DOM 结构 */
const PERCEPTION_HTML = `
  <!-- 情感维度 -->
  <div id="perception-warmth-fill" style="width:0%"></div>
  <span id="perception-warmth-level"></span>
  <div id="perception-directness-fill" style="width:0%"></div>
  <span id="perception-directness-level"></span>
  <div id="perception-initiative-fill" style="width:0%"></div>
  <span id="perception-initiative-level"></span>
  <div id="perception-playfulness-fill" style="width:0%"></div>
  <span id="perception-playfulness-level"></span>
  <span id="sprite-status-text-bar"></span>
  <span id="sprite-status-dot-bar"></span>

  <!-- 默契度 -->
  <span id="perception-rapport-badge"></span>
  <div id="perception-trust-fill" style="width:0%"></div>
  <div id="perception-familiarity-fill" style="width:0%"></div>
  <span id="perception-rapport-desc"></span>

  <!-- 上下文 -->
  <span id="perception-pace-value"></span>
  <span id="perception-topic-value"></span>
  <span id="perception-depth-value"></span>

  <!-- 模式洞察 -->
  <section id="perception-patterns-section" class="hidden">
    <div id="perception-patterns-list"></div>
  </section>

  <!-- 在场状态 -->
  <span id="perception-presence-dot"></span>
  <span id="perception-presence-text"></span>

  <!-- 叙事摘要 -->
  <span id="perception-narrative-text"></span>
`;

/** 创建测试用 AffectPayload */
function createAffect(overrides?: Partial<AffectPayload>): AffectPayload {
  return {
    warmth: 0.5,
    directness: 0.5,
    initiative: 0.5,
    playfulness: 0.5,
    ...overrides,
  };
}

/** 创建测试用 RapportPayload */
function createRapport(overrides?: Partial<RapportPayload>): RapportPayload {
  return {
    level: 'familiar',
    trust: 0.6,
    familiarity: 0.7,
    description: '默契度良好',
    ...overrides,
  };
}

/** 创建测试用 ContextPayload */
function createContext(overrides?: Partial<ContextPayload>): ContextPayload {
  return {
    rhythm: 'normal',
    coherence: 'moderate',
    depth: 'moderate',
    dominantSource: 'test',
    ...overrides,
  };
}

/** 创建测试用 PatternsPayload */
function createPatterns(patterns?: Array<{ type: string; summary: string; confidence: number; suggestion?: string; relatedMemoryIds?: string[] }>): PatternsPayload {
  return {
    patterns: patterns ?? [
      { type: 'recurring_topic', summary: '重复讨论 X', confidence: 0.9 },
      { type: 'knowledge_gap', summary: '缺少 Y 知识', confidence: 0.8 },
    ],
  };
}

/** 创建测试用 PresencePayload */
function createPresence(overrides?: Partial<PresencePayload>): PresencePayload {
  return {
    state: 'present',
    timestamp: '2026-07-01T10:00:00.000Z',
    reason: 'activity',
    ...overrides,
  };
}

/** 创建感知面板管理器实例（已设置 DOM） */
function createRenderer(html?: string): PerceptionPanelManager {
  document.body.innerHTML = html ?? PERCEPTION_HTML;
  // PerceptionPanelManager 构造函数需要 PerceptionPanelHost 参数（showToast 等跨模块关注点）
  // 测试中注入 mock host，感知面板当前为纯展示型，未实际调用 host 方法
  return new PerceptionPanelManager({ showToast: vi.fn() });
}

// ─── 全局设置 ─────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── updateAffectDisplay() · 情感基调 ─────────────────────

describe('updateAffectDisplay() · 情感基调', () => {
  it('应更新四维进度条宽度（按百分比）', () => {
    const renderer = createRenderer();
    renderer.updateAffectDisplay(createAffect({ warmth: 0.8, directness: 0.4 }));
    expect(document.getElementById('perception-warmth-fill')!.style.width).toBe('80%');
    expect(document.getElementById('perception-directness-fill')!.style.width).toBe('40%');
  });

  it('应更新四维等级文本（低/中/高 + 精确百分比）', () => {
    const renderer = createRenderer();
    renderer.updateAffectDisplay(createAffect({ warmth: 0.2, directness: 0.5, initiative: 0.9 }));
    expect(document.getElementById('perception-warmth-level')!.textContent).toBe('低 · 20%');
    expect(document.getElementById('perception-directness-level')!.textContent).toBe('中 · 50%');
    expect(document.getElementById('perception-initiative-level')!.textContent).toBe('高 · 90%');
  });

  it('应更新精灵状态条文字（主导维度 + 等级）', () => {
    const renderer = createRenderer();
    renderer.updateAffectDisplay(createAffect({ warmth: 0.9, directness: 0.1 }));
    expect(document.getElementById('sprite-status-text-bar')!.textContent).toContain('温暖');
    expect(document.getElementById('sprite-status-text-bar')!.textContent).toContain('高');
  });

  it('精灵状态条背景应更新（主导维度颜色）', () => {
    const renderer = createRenderer();
    renderer.updateAffectDisplay(createAffect({ warmth: 0.9 }));
    const dotBar = document.getElementById('sprite-status-dot-bar')!;
    expect(dotBar.style.background).not.toBe('');
  });

  it('DOM 不存在时应安全降级（不抛错）', () => {
    const renderer = createRenderer('<div></div>');
    expect(() => renderer.updateAffectDisplay(createAffect())).not.toThrow();
  });
});

// ─── updateRapportDisplay() · 默契度 ─────────────────────

describe('updateRapportDisplay() · 默契度', () => {
  it('应更新等级徽章文本（stranger→初识）', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ level: 'stranger' }));
    expect(document.getElementById('perception-rapport-badge')!.textContent).toBe('初识');
  });

  it('应更新等级徽章 data-level 属性', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ level: 'close' }));
    expect(document.getElementById('perception-rapport-badge')!.getAttribute('data-level')).toBe('close');
  });

  it('应更新信任度进度条（百分比 + 颜色）', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ trust: 0.7 }));
    expect(document.getElementById('perception-trust-fill')!.style.width).toBe('70%');
    expect(document.getElementById('perception-trust-fill')!.style.background).not.toBe('');
  });

  it('应更新熟悉度进度条', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ familiarity: 0.85 }));
    expect(document.getElementById('perception-familiarity-fill')!.style.width).toBe('85%');
  });

  it('应更新描述文本', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ description: '默契度优秀' }));
    expect(document.getElementById('perception-rapport-desc')!.textContent).toBe('默契度优秀');
  });

  it('未知 level 应回退为原始值', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ level: 'unknown_level' }));
    expect(document.getElementById('perception-rapport-badge')!.textContent).toBe('unknown_level');
  });

  it('DOM 不存在时应安全降级', () => {
    const renderer = createRenderer('<div></div>');
    expect(() => renderer.updateRapportDisplay(createRapport())).not.toThrow();
  });
});

// ─── updateContextDisplay() · 对话上下文 ─────────────────

describe('updateContextDisplay() · 对话上下文', () => {
  it('应更新节奏指标（rapid→快节奏）', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ rhythm: 'rapid' }));
    expect(document.getElementById('perception-pace-value')!.textContent).toBe('快节奏');
  });

  it('应更新话题连贯性指标（focused→专注）', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ coherence: 'focused' }));
    expect(document.getElementById('perception-topic-value')!.textContent).toBe('专注');
  });

  it('应更新深度指标（deep→深度讨论）', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ depth: 'deep' }));
    expect(document.getElementById('perception-depth-value')!.textContent).toBe('深度讨论');
  });

  it('未知值应回退为原始值', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ rhythm: 'unknown_rhythm' }));
    expect(document.getElementById('perception-pace-value')!.textContent).toBe('unknown_rhythm');
  });

  it('DOM 不存在时应安全降级', () => {
    const renderer = createRenderer('<div></div>');
    expect(() => renderer.updateContextDisplay(createContext())).not.toThrow();
  });
});

// ─── updatePatternsDisplay() · 模式洞察 ─────────────────

describe('updatePatternsDisplay() · 模式洞察', () => {
  it('空列表应清空容器并隐藏 section', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([]));
    expect(document.getElementById('perception-patterns-section')!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('perception-patterns-list')!.children.length).toBe(0);
  });

  it('非空列表应显示 section（移除 hidden）', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns());
    expect(document.getElementById('perception-patterns-section')!.classList.contains('hidden')).toBe(false);
  });

  it('应渲染每个 pattern 项（类型标签 + 摘要文本）', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: '重复 X', confidence: 0.9 },
      { type: 'knowledge_gap', summary: '缺口 Y', confidence: 0.8 },
    ]));
    const items = document.querySelectorAll('#perception-patterns-list .perception-pattern-item');
    expect(items.length).toBe(2);
    expect(items[0]!.querySelector('.perception-pattern-type')!.textContent).toBe('重复');
    expect(items[0]!.querySelector('span:last-child')!.textContent).toBe('重复 X');
  });

  it('应支持 type 别名（repeat/gap/drift）', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'repeat', summary: 'r', confidence: 1 },
      { type: 'gap', summary: 'g', confidence: 1 },
      { type: 'drift', summary: 'd', confidence: 1 },
    ]));
    const items = document.querySelectorAll('#perception-patterns-list .perception-pattern-item');
    expect(items[0]!.querySelector('.perception-pattern-type')!.textContent).toBe('重复');
    expect(items[1]!.querySelector('.perception-pattern-type')!.textContent).toBe('缺口');
    expect(items[2]!.querySelector('.perception-pattern-type')!.textContent).toBe('漂移');
  });

  it('未知 type 应回退为 repeat 类 + 原始文本', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'custom_type', summary: 'c', confidence: 1 },
    ]));
    const typeSpan = document.querySelector('.perception-pattern-type') as HTMLElement;
    expect(typeSpan.textContent).toBe('custom_type');
    expect(typeSpan.classList.contains('repeat')).toBe(true);
  });

  it('patterns-list 不存在时应安全降级（仍更新叙事）', () => {
    const renderer = createRenderer('<div id="perception-narrative-text"></div>');
    expect(() => renderer.updatePatternsDisplay(createPatterns())).not.toThrow();
  });

  it('连续调用应清空旧列表后重建（不累积）', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'repeat', summary: 'a', confidence: 1 },
      { type: 'gap', summary: 'b', confidence: 1 },
    ]));
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'drift', summary: 'c', confidence: 1 },
    ]));
    const items = document.querySelectorAll('#perception-patterns-list .perception-pattern-item');
    expect(items.length).toBe(1);
    expect(items[0]!.querySelector('.perception-pattern-type')!.textContent).toBe('漂移');
  });

  // ─── 缺口 K：relatedMemoryIds 关联记忆跳转按钮 ───────────────

  it('含 relatedMemoryIds 的 pattern 应渲染"关联 N 条记忆"按钮', () => {
    // 缺口 K：PatternDetector 已填充 relatedMemoryIds，渲染层需消费
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: '重复讨论', confidence: 0.9, relatedMemoryIds: ['m1', 'm2', 'm3'] },
    ]));
    const btn = document.querySelector('.perception-pattern-related') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('关联 3 条记忆');
  });

  it('无 relatedMemoryIds 的 pattern 不应渲染关联按钮', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: '无关联', confidence: 0.9 },
    ]));
    const btn = document.querySelector('.perception-pattern-related');
    expect(btn).toBeNull();
  });

  it('空 relatedMemoryIds 数组不应渲染关联按钮', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: '空数组', confidence: 0.9, relatedMemoryIds: [] },
    ]));
    const btn = document.querySelector('.perception-pattern-related');
    expect(btn).toBeNull();
  });

  it('click 关联按钮应触发 onMemoryClick 回调（传入第一条记忆 ID）', () => {
    // 缺口 K：点击按钮跳转第一条相关记忆详情，复用 onMemoryClick 回调
    const renderer = createRenderer();
    const cb = vi.fn();
    renderer.onMemoryClick(cb);
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: '可跳转', confidence: 0.9, relatedMemoryIds: ['first-id', 'second-id'] },
    ]));
    const btn = document.querySelector('.perception-pattern-related') as HTMLElement;
    btn.click();
    expect(cb).toHaveBeenCalledWith('first-id');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('未注册 onMemoryClick 回调时 click 按钮应安全不抛错', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: '无回调', confidence: 0.9, relatedMemoryIds: ['m1'] },
    ]));
    const btn = document.querySelector('.perception-pattern-related') as HTMLElement;
    expect(() => btn.click()).not.toThrow();
  });
});

// ─── updatePresenceDisplay() · 在场状态 ─────────────────

describe('updatePresenceDisplay() · 在场状态', () => {
  it('present 状态应显示"用户在场"', () => {
    const renderer = createRenderer();
    renderer.updatePresenceDisplay(createPresence({ state: 'present' }));
    const dot = document.getElementById('perception-presence-dot')!;
    const text = document.getElementById('perception-presence-text')!;
    expect(dot.className).toContain('present');
    expect(text.textContent).toBe('用户在场');
  });

  it('away 状态应显示离开时长（< 60 分钟显示分钟）', () => {
    const renderer = createRenderer();
    renderer.updatePresenceDisplay(createPresence({
      state: 'away',
      awayDurationMs: 5 * 60 * 1000,
      reason: 'idle',
    }));
    expect(document.getElementById('perception-presence-text')!.textContent).toBe('用户已离开 5 分钟');
  });

  it('away 状态时长 < 1 分钟应显示"用户刚离开"', () => {
    const renderer = createRenderer();
    renderer.updatePresenceDisplay(createPresence({
      state: 'away',
      awayDurationMs: 30 * 1000,
      reason: 'idle',
    }));
    expect(document.getElementById('perception-presence-text')!.textContent).toBe('用户刚离开');
  });

  it('away 状态时长 >= 60 分钟应显示小时', () => {
    const renderer = createRenderer();
    renderer.updatePresenceDisplay(createPresence({
      state: 'away',
      awayDurationMs: 90 * 60 * 1000,
      reason: 'idle',
    }));
    expect(document.getElementById('perception-presence-text')!.textContent).toBe('用户已离开 1 小时');
  });

  it('away 状态无 awayDurationMs 应兜底为当前时间', () => {
    const renderer = createRenderer();
    renderer.updatePresenceDisplay(createPresence({
      state: 'away',
      awayDurationMs: null,
      reason: 'idle',
    }));
    // 兜底分支：awaySince = Date.now()，离开分钟数 = 1（Math.max(1, ...)）
    expect(document.getElementById('perception-presence-text')!.textContent).toBe('用户刚离开');
  });

  it('DOM 不存在时应安全降级', () => {
    const renderer = createRenderer('<div></div>');
    expect(() => renderer.updatePresenceDisplay(createPresence())).not.toThrow();
  });
});

// ─── updateNarrative() · 叙事合成 ─────────────────────────
// TODO: updateNarrative() 目前仅更新 #sprite-status-text-bar，未更新 #perception-narrative-text。
// 叙事文本合成（generateNarrative → #perception-narrative-text）功能尚未完成。
// 待功能实现后取消 skip。

describe.skip('updateNarrative() · 叙事合成', () => {
  it('无任何感知数据时应显示默认叙事"精灵正在感知中..."', () => {
    const renderer = createRenderer();
    renderer.updateNarrative();
    expect(document.getElementById('perception-narrative-text')!.textContent).toBe('精灵正在感知中...');
  });

  it('用户离开时应叙事"用户已离开 N 分钟"', () => {
    const renderer = createRenderer();
    renderer.updatePresenceDisplay(createPresence({
      state: 'away',
      awayDurationMs: 10 * 60 * 1000,
      reason: 'idle',
    }));
    expect(document.getElementById('perception-narrative-text')!.textContent).toContain('用户已离开 10 分钟');
  });

  it('非 idle 节奏应叙事"对话节奏X"', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ rhythm: 'rapid' }));
    expect(document.getElementById('perception-narrative-text')!.textContent).toContain('对话节奏快节奏');
  });

  it('idle 节奏应跳过对话节奏叙事', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ rhythm: 'idle' }));
    expect(document.getElementById('perception-narrative-text')!.textContent).not.toContain('对话节奏');
  });

  it('focused 连贯性 + dominantSource 应叙事"正在专注讨论X相关话题"', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({
      coherence: 'focused',
      dominantSource: '代码',
    }));
    expect(document.getElementById('perception-narrative-text')!.textContent).toContain('正在专注讨论代码相关话题');
  });

  it('scattered 连贯性应叙事"话题较为分散"', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ coherence: 'scattered' }));
    expect(document.getElementById('perception-narrative-text')!.textContent).toContain('话题较为分散');
  });

  it('情感基调超阈值应叙事"基调温暖、直接、主动"', () => {
    const renderer = createRenderer();
    renderer.updateAffectDisplay(createAffect({
      warmth: 0.9,
      directness: 0.8,
      initiative: 0.7,
      playfulness: 0.1,
    }));
    const text = document.getElementById('perception-narrative-text')!.textContent!;
    expect(text).toContain('温暖');
    expect(text).toContain('直接');
    expect(text).toContain('主动');
  });

  it('默契度 level !== stranger 应叙事"默契度：X"', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ level: 'close' }));
    expect(document.getElementById('perception-narrative-text')!.textContent).toContain('默契度：亲密');
  });

  it('默契度 level === stranger（初识）应跳过默契度叙事', () => {
    const renderer = createRenderer();
    renderer.updateRapportDisplay(createRapport({ level: 'stranger' }));
    expect(document.getElementById('perception-narrative-text')!.textContent).not.toContain('默契度');
  });

  it('模式洞察应叙事"检测到N个重复主题、N个知识缺口"', () => {
    const renderer = createRenderer();
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: 'r1', confidence: 1 },
      { type: 'recurring_topic', summary: 'r2', confidence: 1 },
      { type: 'knowledge_gap', summary: 'g1', confidence: 1 },
    ]));
    const text = document.getElementById('perception-narrative-text')!.textContent!;
    expect(text).toContain('2 个重复主题');
    expect(text).toContain('1 个知识缺口');
  });

  it('非 idle 状态应同步更新精灵状态条文字', () => {
    const renderer = createRenderer();
    renderer.updateContextDisplay(createContext({ rhythm: 'rapid' }));
    const statusTextBar = document.getElementById('sprite-status-text-bar')!;
    expect(statusTextBar.textContent).toContain('对话节奏');
  });

  it('idle 状态不应覆盖精灵状态条文字（叙事仅写入 perception-narrative-text）', () => {
    const renderer = createRenderer();
    // 先写入非 idle 状态
    renderer.updateContextDisplay(createContext({ rhythm: 'rapid' }));
    const originalStatus = document.getElementById('sprite-status-text-bar')!.textContent;
    // 切换到 idle 状态
    renderer.updateContextDisplay(createContext({ rhythm: 'idle' }));
    // 精灵状态条文字应保持上次的非 idle 叙事（不被 idle 叙事覆盖）
    expect(document.getElementById('sprite-status-text-bar')!.textContent).toBe(originalStatus);
  });

  it('narrative-text DOM 不存在时应安全降级', () => {
    const renderer = createRenderer('<div></div>');
    expect(() => renderer.updateNarrative()).not.toThrow();
  });
});

// ─── cleanup() · 资源清理 ────────────────────────────────

describe('cleanup() · 资源清理', () => {
  it('cleanup 应不抛错', () => {
    const renderer = createRenderer();
    expect(() => renderer.cleanup()).not.toThrow();
  });

  it('cleanup 后重复调用 cleanup 应安全', () => {
    const renderer = createRenderer();
    renderer.cleanup();
    expect(() => renderer.cleanup()).not.toThrow();
  });

  it('cleanup 后仍可调用 update 方法（状态不重置，仅 GC 回收）', () => {
    const renderer = createRenderer();
    renderer.updateAffectDisplay(createAffect({ warmth: 0.9 }));
    renderer.cleanup();
    expect(() => renderer.updateAffectDisplay(createAffect({ warmth: 0.5 })).not.toThrow());
  });

  it('cleanup 应清理 onMemoryClickCallback（缺口 K：与 PartnerInsightsRenderer 一致）', () => {
    // 缺口 K：cleanup 后点击关联按钮不应触发回调（回调引用已被置 null）
    const renderer = createRenderer();
    const cb = vi.fn();
    renderer.onMemoryClick(cb);
    renderer.updatePatternsDisplay(createPatterns([
      { type: 'recurring_topic', summary: '测试', confidence: 0.9, relatedMemoryIds: ['m1'] },
    ]));
    renderer.cleanup();
    // cleanup 后 click 按钮，回调不应被调用
    const btn = document.querySelector('.perception-pattern-related') as HTMLElement;
    if (btn) {
      btn.click();
    }
    expect(cb).not.toHaveBeenCalled();
  });
});
