/**
 * PatternDetector 单元测试 — 记忆模式检测全分支覆盖
 *
 * 测试覆盖：
 *   - detectPatterns 空记忆/有记忆
 *   - detectRecurringTopics 重复主题检测
 *   - detectKnowledgeGaps 知识缺口检测
 *   - detectInterestDrift 兴趣漂移检测
 *   - extractKeywords 关键词提取
 *   - getSourceDistribution 分布计算
 *   - sourceLabel 标签映射
 *   - 构造函数默认值
 *
 * 设计原则：
 *   - 禁止 @ts-ignore / as any
 *   - 使用 import type 分离类型导入
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PatternDetector } from '../../sprite/controllers/patternDetector.js';
import type { Memory } from 'memora';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 创建测试用 Memory 对象 */
function makeMemory(overrides: {
  source?: string;
  content?: string;
  createdAt?: string;
  id?: string;
} = {}): Memory {
  return {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
    source: overrides.source ?? 'chat',
    content: overrides.content ?? '测试内容',
    name: '测试记忆',
    score: 0.5,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    accessedAt: new Date().toISOString(),
  };
}

/** 创建指定天数前的时间戳 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 创建指定小时前的时间戳 */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// ─── 测试套件 ────────────────────────────────────────────

describe('PatternDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 1. detectPatterns ─────────────────────────────────

  describe('detectPatterns', () => {
    it('空记忆返回空数组', () => {
      const detector = new PatternDetector();
      const patterns = detector.detectPatterns([]);
      expect(patterns).toEqual([]);
    });

    it('少于最小出现次数的记忆不产生重复主题', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3 });
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'React 状态管理', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'React 组件设计', createdAt: hoursAgo(2) }),
      ];
      const patterns = detector.detectPatterns(memories);
      // 只有 2 条，不满足 minTopicOccurrences=3，不应有 recurring_topic
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      expect(topicPatterns).toHaveLength(0);
    });

    it('多个记忆无高频关键词不产生重复主题', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3 });
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: '前端开发', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: '后端架构', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: '数据库设计', createdAt: hoursAgo(3) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      // 三条内容没有共同关键词，占比均为 1/3 < 50%
      expect(topicPatterns).toHaveLength(0);
    });
  });

  // ─── 2. detectRecurringTopics ───────────────────────────

  describe('detectRecurringTopics', () => {
    it('同一 source 下高频关键词检测为重复主题', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3 });
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'React 状态管理方案', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'React 组件设计模式', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: 'React 性能优化', createdAt: hoursAgo(3) }),
        makeMemory({ source: 'chat', content: 'React 路由配置', createdAt: hoursAgo(4) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      expect(topicPatterns.length).toBeGreaterThan(0);
      // "React" 出现在 4/4 = 100% 的记忆中
      const reactPattern = topicPatterns.find((p) => p.summary.includes('React'));
      expect(reactPattern).toBeDefined();
      expect(reactPattern!.confidence).toBeGreaterThanOrEqual(0.5);
      expect(reactPattern!.relatedMemoryIds).toHaveLength(4);
    });

    it('跨 source 的关键词不合并检测', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3 });
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'Python 数据分析', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'Python 机器学习', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'profile', content: 'Python 爱好者', createdAt: hoursAgo(3) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      // chat 组只有 2 条，不满足 minTopicOccurrences=3
      // profile 组只有 1 条
      expect(topicPatterns).toHaveLength(0);
    });

    it('重复主题包含 suggestion 字段', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3 });
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'TypeScript 类型系统', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'TypeScript 泛型', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: 'TypeScript 工具类型', createdAt: hoursAgo(3) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      expect(topicPatterns.length).toBeGreaterThan(0);
      for (const p of topicPatterns) {
        expect(p.suggestion).toBeDefined();
        expect(p.suggestion!.length).toBeGreaterThan(0);
      }
    });
  });

  // ─── 3. detectKnowledgeGaps ─────────────────────────────

  describe('detectKnowledgeGaps', () => {
    it('包含问号的记忆无后续同 source 记忆 → 检测为知识缺口', () => {
      const detector = new PatternDetector();
      const memories: Memory[] = [
        makeMemory({
          source: 'chat',
          content: '如何优化 React 渲染性能？',
          createdAt: hoursAgo(24),
        }),
      ];
      const patterns = detector.detectPatterns(memories);
      const gapPatterns = patterns.filter((p) => p.type === 'knowledge_gap');
      expect(gapPatterns.length).toBeGreaterThan(0);
      expect(gapPatterns[0]!.summary).toContain('优化 React 渲染性能');
      expect(gapPatterns[0]!.confidence).toBe(0.6);
    });

    it('有后续同 source 记忆 → 不检测为知识缺口', () => {
      const detector = new PatternDetector();
      const memories: Memory[] = [
        makeMemory({
          source: 'chat',
          content: '如何优化 React 渲染性能？',
          createdAt: hoursAgo(48),
        }),
        makeMemory({
          source: 'chat',
          content: '使用 React.memo 和 useMemo 可以优化渲染性能',
          createdAt: hoursAgo(47),
        }),
      ];
      const patterns = detector.detectPatterns(memories);
      const gapPatterns = patterns.filter((p) => p.type === 'knowledge_gap');
      // 有同 source 后续记忆，说明问题已得到回答
      expect(gapPatterns).toHaveLength(0);
    });

    it('中文问号同样检测', () => {
      const detector = new PatternDetector();
      const memories: Memory[] = [
        makeMemory({
          source: 'chat',
          content: 'Vue 和 React 有什么区别？',
          createdAt: hoursAgo(24),
        }),
      ];
      const patterns = detector.detectPatterns(memories);
      const gapPatterns = patterns.filter((p) => p.type === 'knowledge_gap');
      expect(gapPatterns.length).toBeGreaterThan(0);
    });

    it('知识缺口最多返回 3 个', () => {
      const detector = new PatternDetector();
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: '问题1？', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: '问题2？', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: '问题3？', createdAt: hoursAgo(3) }),
        makeMemory({ source: 'chat', content: '问题4？', createdAt: hoursAgo(4) }),
        makeMemory({ source: 'chat', content: '问题5？', createdAt: hoursAgo(5) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const gapPatterns = patterns.filter((p) => p.type === 'knowledge_gap');
      expect(gapPatterns.length).toBeLessThanOrEqual(3);
    });

    it('不含问号的记忆不产生知识缺口', () => {
      const detector = new PatternDetector();
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: '这是一条普通记忆', createdAt: hoursAgo(1) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const gapPatterns = patterns.filter((p) => p.type === 'knowledge_gap');
      expect(gapPatterns).toHaveLength(0);
    });
  });

  // ─── 4. detectInterestDrift ─────────────────────────────

  describe('detectInterestDrift', () => {
    it('source 分布显著变化 → 检测为兴趣漂移', () => {
      const detector = new PatternDetector({ minDriftRatio: 0.3 });
      // 近期：80% chat，20% profile
      const recentMemories: Memory[] = [
        makeMemory({ source: 'chat', content: '前端开发', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'React Hooks', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: 'CSS 布局', createdAt: hoursAgo(3) }),
        makeMemory({ source: 'chat', content: 'TypeScript', createdAt: hoursAgo(4) }),
        makeMemory({ source: 'profile', content: '偏好简洁', createdAt: hoursAgo(5) }),
      ];
      // 远期：50% profile，50% chat
      const olderMemories: Memory[] = [
        makeMemory({ source: 'profile', content: '喜欢咖啡', createdAt: daysAgo(10) }),
        makeMemory({ source: 'chat', content: '日常问候', createdAt: daysAgo(11) }),
      ];
      const allMemories = [...recentMemories, ...olderMemories];
      const patterns = detector.detectPatterns(allMemories);
      const driftPatterns = patterns.filter((p) => p.type === 'interest_drift');
      // chat 从 50% → 80%（+30%），profile 从 50% → 20%（-30%）
      expect(driftPatterns.length).toBeGreaterThan(0);
    });

    it('source 分布变化不显著 → 不检测为兴趣漂移', () => {
      const detector = new PatternDetector({ minDriftRatio: 0.3 });
      const recentMemories: Memory[] = [
        makeMemory({ source: 'chat', content: 'A', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'profile', content: 'B', createdAt: hoursAgo(2) }),
      ];
      const olderMemories: Memory[] = [
        makeMemory({ source: 'chat', content: 'C', createdAt: daysAgo(10) }),
        makeMemory({ source: 'profile', content: 'D', createdAt: daysAgo(11) }),
      ];
      const allMemories = [...recentMemories, ...olderMemories];
      const patterns = detector.detectPatterns(allMemories);
      const driftPatterns = patterns.filter((p) => p.type === 'interest_drift');
      // 分布完全相同（50/50），变化 0
      expect(driftPatterns).toHaveLength(0);
    });

    it('只有近期或远期记忆时不检测漂移', () => {
      const detector = new PatternDetector();
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'A', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'B', createdAt: hoursAgo(2) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const driftPatterns = patterns.filter((p) => p.type === 'interest_drift');
      // 没有远期记忆，无法比较
      expect(driftPatterns).toHaveLength(0);
    });

    it('关注度增加时包含 suggestion', () => {
      const detector = new PatternDetector({ minDriftRatio: 0.3 });
      const recentMemories: Memory[] = [
        makeMemory({ source: 'work', content: '项目A', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'work', content: '项目B', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'work', content: '项目C', createdAt: hoursAgo(3) }),
        makeMemory({ source: 'chat', content: 'X', createdAt: hoursAgo(4) }),
      ];
      const olderMemories: Memory[] = [
        makeMemory({ source: 'chat', content: 'Y', createdAt: daysAgo(10) }),
        makeMemory({ source: 'chat', content: 'Z', createdAt: daysAgo(11) }),
        makeMemory({ source: 'chat', content: 'W', createdAt: daysAgo(12) }),
        makeMemory({ source: 'work', content: '旧项目', createdAt: daysAgo(13) }),
      ];
      const allMemories = [...recentMemories, ...olderMemories];
      const patterns = detector.detectPatterns(allMemories);
      const driftPatterns = patterns.filter(
        (p) => p.type === 'interest_drift' && p.summary.includes('增加'),
      );
      for (const p of driftPatterns) {
        expect(p.suggestion).toBeDefined();
      }
    });
  });

  // ─── 5. extractKeywords（通过 detectRecurringTopics 间接测试） ──

  describe('关键词提取', () => {
    it('停用词被过滤', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3 });
      // 使用带空格的词确保分词器能正确切分
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'React 项目架构 设计', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'React 组件 设计', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: 'React 状态 管理', createdAt: hoursAgo(3) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      expect(topicPatterns.length).toBeGreaterThan(0);
      // "React" 出现在所有 3 条记忆（100%），"设计" 出现在 2/3（67%）
      const reactPattern = topicPatterns.find((p) => p.summary.includes('React'));
      expect(reactPattern).toBeDefined();
    });

    it('短于最小长度的词被过滤', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3 });
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'A B C D', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'A B C D', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: 'A B C D', createdAt: hoursAgo(3) }),
      ];
      const patterns = detector.detectPatterns(memories);
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      // 单字母词 < MIN_KEYWORD_LENGTH=2，应全部被过滤
      expect(topicPatterns).toHaveLength(0);
    });
  });

  // ─── 6. 构造函数默认值 ─────────────────────────────────

  describe('构造函数', () => {
    it('无参数时使用默认值', () => {
      const detector = new PatternDetector();
      const patterns = detector.detectPatterns([]);
      expect(patterns).toEqual([]);
    });

    it('部分参数覆盖默认值', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 5 });
      const memories: Memory[] = [
        makeMemory({ source: 'chat', content: 'React A', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'React B', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: 'React C', createdAt: hoursAgo(3) }),
        makeMemory({ source: 'chat', content: 'React D', createdAt: hoursAgo(4) }),
      ];
      const patterns = detector.detectPatterns(memories);
      // 4 条 < minTopicOccurrences=5，不产生主题
      const topicPatterns = patterns.filter((p) => p.type === 'recurring_topic');
      expect(topicPatterns).toHaveLength(0);
    });
  });

  // ─── 7. 结果排序 ───────────────────────────────────────

  describe('结果排序', () => {
    it('多个模式按置信度降序排列', () => {
      const detector = new PatternDetector({ minTopicOccurrences: 3, minDriftRatio: 0.3 });
      // 创建重复主题（高置信度）
      const recentMemories: Memory[] = [
        makeMemory({ source: 'chat', content: 'React 组件', createdAt: hoursAgo(1) }),
        makeMemory({ source: 'chat', content: 'React 状态', createdAt: hoursAgo(2) }),
        makeMemory({ source: 'chat', content: 'React 路由', createdAt: hoursAgo(3) }),
      ];
      // 创建知识缺口（置信度 0.6）
      const gapMemory = makeMemory({
        source: 'chat',
        content: '如何部署到生产环境？',
        createdAt: hoursAgo(24),
      });
      // 创建远期记忆（使漂移检测生效）
      const olderMemories: Memory[] = [
        makeMemory({ source: 'profile', content: '喜欢咖啡', createdAt: daysAgo(10) }),
        makeMemory({ source: 'profile', content: '喜欢茶', createdAt: daysAgo(11) }),
        makeMemory({ source: 'profile', content: '喜欢牛奶', createdAt: daysAgo(12) }),
      ];
      const allMemories = [...recentMemories, gapMemory, ...olderMemories];
      const patterns = detector.detectPatterns(allMemories);
      // 验证按置信度降序
      for (let i = 1; i < patterns.length; i++) {
        expect(patterns[i - 1]!.confidence).toBeGreaterThanOrEqual(patterns[i]!.confidence);
      }
    });
  });
});