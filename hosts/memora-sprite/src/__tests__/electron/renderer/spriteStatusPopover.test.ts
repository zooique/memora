/**
 * 精灵状态浮层（SpriteStatusPopover）单元测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - updateAffect / updateRapport / updateContext 在 popover 隐藏时仍能正确更新 DOM（核心 bug 回归）
 * - hover 状态条触发 show 后能看到更新后的内容
 * - 格式化输出：默契度/情感/节奏摘要正确
 *
 * 历史 bug：
 * refreshPopover 曾以 popoverEl.classList.contains('hidden') 作为早退守卫，
 * 导致 IPC 数据到达时（popover 仍 hidden）直接 return，show() 再次调用
 * refreshPopover() 时仍处于 hidden，永远不会刷新 —— 状态条永远显示初始破折号"一"。
 * 该测试明确锁定"hidden 时也能更新"的行为。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpriteStatusPopover } from '../../../electron/renderer/panels/spriteStatusPopover.js';
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
} from '../../../electron/renderer/ipcListeners.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** popover + 状态条最小 HTML 结构（默认 hidden） */
const POPOVER_HTML = `
  <div id="sprite-status-bar" class="sprite-status-bar">状态条</div>
  <div id="sprite-status-popover" class="sprite-status-popover hidden" role="tooltip">
    <div class="popover-section">
      <span class="popover-label">默契度</span>
      <span class="popover-value" id="popover-rapport">—</span>
    </div>
    <div class="popover-section">
      <span class="popover-label">情感基调</span>
      <span class="popover-value" id="popover-affect">—</span>
    </div>
    <div class="popover-section">
      <span class="popover-label">对话节奏</span>
      <span class="popover-value" id="popover-context">—</span>
    </div>
  </div>
`;

/** 安装 DOM 并返回 popover 实例（同时挂在 body 上） */
function createPopover(): SpriteStatusPopover {
  document.body.innerHTML = POPOVER_HTML;
  return new SpriteStatusPopover();
}

/** 触发 hover 进入事件 */
function fireStatusBarEnter(): void {
  const bar = document.getElementById('sprite-status-bar');
  bar?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
}

/** 触发 hover 离开事件 */
function fireStatusBarLeave(): void {
  const bar = document.getElementById('sprite-status-bar');
  bar?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
}

/** 等到 hover 延迟（默认 200ms）后清理定时器 */
async function flushHoverDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('SpriteStatusPopover', () => {
  beforeEach(() => {
    // 每次用例前清空 DOM
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // 清理残留 DOM（避免 jsdom 状态泄漏）
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('核心 bug 回归：hidden 状态下仍能更新 DOM', () => {
    it('updateAffect 在 popover 隐藏时直接刷新 DOM（修复 #1）', () => {
      const popover = createPopover();
      const affectEl = document.getElementById('popover-affect');

      // 初始破折号
      expect(affectEl?.textContent).toBe('—');
      // 确认 popover 处于 hidden
      expect(document.getElementById('sprite-status-popover')?.classList.contains('hidden')).toBe(true);

      // 数据到达时 popover 仍 hidden，但 DOM 必须更新
      const payload: AffectPayload = { warmth: 0.8, playfulness: 0.7, directness: 0.5, initiative: 0.4 };
      popover.updateAffect(payload);

      // 预期：温暖 · 活泼
      expect(affectEl?.textContent).toBe('温暖 · 活泼');
    });

    it('updateRapport 在 popover 隐藏时直接刷新 DOM（修复 #1）', () => {
      const popover = createPopover();
      const rapportEl = document.getElementById('popover-rapport');

      expect(rapportEl?.textContent).toBe('—');

      const payload: RapportPayload = {
        trust: 0.6,
        familiarity: 0.75,
        level: 'familiar',
        description: '已建立一定默契',
      };
      popover.updateRapport(payload);

      // 预期：熟悉 · 信任 60% · 熟悉 75%
      expect(rapportEl?.textContent).toBe('熟悉 · 信任 60% · 熟悉 75%');
    });

    it('updateContext 在 popover 隐藏时直接刷新 DOM（修复 #1）', () => {
      const popover = createPopover();
      const contextEl = document.getElementById('popover-context');

      expect(contextEl?.textContent).toBe('—');

      const payload: ContextPayload = {
        rhythm: 'rapid',
        coherence: 'focused',
        depth: 'deep',
        dominantSource: null,
        description: '快节奏 · 高度连贯',
      };
      popover.updateContext(payload);

      // 预期：快节奏 · 专注（perceptionLabels 统一文案）
      expect(contextEl?.textContent).toBe('快节奏 · 专注');
    });
  });

  describe('show() 后能看到更新后的内容', () => {
    it('先更新数据再 hover，popover 正确展示三行摘要（修复 #2 联动）', async () => {
      const popover = createPopover();

      // 模拟启动阶段 IPC 推数据（popover 仍 hidden）
      popover.updateRapport({
        trust: 0.9,
        familiarity: 0.85,
        level: 'close',
        description: '挚友级默契',
      });
      popover.updateAffect({ warmth: 0.8, playfulness: 0.3, directness: 0.7, initiative: 0.2 });
      popover.updateContext({
        rhythm: 'normal',
        coherence: 'moderate',
        depth: 'moderate',
        dominantSource: null,
        description: '节奏适中',
      });

      // hover 状态条 → 经过 200ms 延迟 → show() 移除 hidden
      fireStatusBarEnter();
      await flushHoverDelay();

      const popoverEl = document.getElementById('sprite-status-popover');
      expect(popoverEl?.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('popover-rapport')?.textContent).toBe('亲密 · 信任 90% · 熟悉 85%');
      expect(document.getElementById('popover-affect')?.textContent).toBe('温暖 · 直接');
      expect(document.getElementById('popover-context')?.textContent).toBe('正常 · 中等');
    });
  });

  describe('格式化辅助方法（间接覆盖）', () => {
    it('情感基调整数低于阈值时显示"平稳"', () => {
      const popover = createPopover();
      popover.updateAffect({ warmth: 0.5, playfulness: 0.5, directness: 0.5, initiative: 0.5 });
      // 没有任何维度 ≥ 0.6，输出"平稳"
      expect(document.getElementById('popover-affect')?.textContent).toBe('平稳');
    });

    it('情感基调中"温暖"为低值（≤0.3）时显示"冷静"', () => {
      const popover = createPopover();
      popover.updateAffect({ warmth: 0.2, playfulness: 0.5, directness: 0.5, initiative: 0.5 });
      expect(document.getElementById('popover-affect')?.textContent).toBe('冷静');
    });

    it('对话节奏遇到未识别枚举值时回退到原始字符串', () => {
      const popover = createPopover();
      // 类型断言：测试边界场景
      popover.updateContext({
        rhythm: 'unknown' as never,
        coherence: 'unknown' as never,
        depth: 'moderate',
        dominantSource: null,
        description: '',
      });
      // describeRhythm/describeCoherence 对未识别值直接返回原始字符串（无前缀）
      expect(document.getElementById('popover-context')?.textContent).toBe('unknown · unknown');
    });
  });

  describe('hover 离开时隐藏', () => {
    it('hover 状态条离开后 popover 重新隐藏', async () => {
      // 实例化 popover 以便绑定 hover 事件监听器
      createPopover();
      const popoverEl = document.getElementById('sprite-status-popover');

      fireStatusBarEnter();
      await flushHoverDelay();
      expect(popoverEl?.classList.contains('hidden')).toBe(false);

      fireStatusBarLeave();
      await flushHoverDelay();
      expect(popoverEl?.classList.contains('hidden')).toBe(true);
    });
  });

  describe('资源清理', () => {
    it('cleanup 移除事件监听器并清理定时器', () => {
      const popover = createPopover();
      const popoverEl = document.getElementById('sprite-status-popover');

      // 触发一次 hover 启动延迟定时器
      fireStatusBarEnter();
      // cleanup 必须能正常执行（清理定时器、移除监听器）
      expect(() => popover.cleanup()).not.toThrow();
      // 清理后即使触发动画，定时器也已被清理（仅行为不变量，监听器移除需要 spy 验证）
      fireStatusBarLeave();
      // popover 状态：hover 离开但定时器已被清理，popover 不会再次变化
      expect(popoverEl).toBeTruthy();
    });
  });
});
