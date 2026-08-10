/**
 * ConfigManager 单元测试
 *
 * 覆盖方法：
 * - addRule：正常添加规则 + 拒绝非 rule source
 * - addSimpleRule：验证自动填充字段
 * - addSkill：正常添加技能 + 拒绝非 skill source
 * - addSimpleSkill：验证自动填充字段
 * - onSuggestion / suggestionCallback：注册和获取回调
 * - confirm：验证 writeConfigFile 未设置时抛错
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SkillManager } from '@/skill/skillManager.js';
import { ConfigManager } from '@/agent/managers/configManager.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Memory } from '@/memory/types.js';
import type { ConfigSuggestion } from '@/agent/managers/configManager.js';
import { logger } from '@/logging/logger.js';

describe('ConfigManager', () => {
  let storage: InMemoryStorage;
  let skillManager: SkillManager;
  let systemMessages: string[];
  let manager: ConfigManager;

  beforeEach(() => {
    storage = new InMemoryStorage();
    skillManager = new SkillManager();
    systemMessages = [];
    manager = new ConfigManager({
      index: storage,
      skillManager,
      injectSystemMessage: (msg) => { systemMessages.push(msg); },
      refreshBootstrapMemories: vi.fn(), // 必选（P1-1：CRUD 后须同步 bootstrap 段）
    });
  });

  // ─── addRule ─────────────────────────────────────────

  describe('addRule', () => {
    it('应成功添加 rule 记忆并注入 system 消息', async () => {
      const now = new Date().toISOString();
      const rule: Memory = {
        id: 'rule:test',
        content: '测试规则内容',
        source: SOURCE_LABELS.RULE,
        name: '测试规则',
        createdAt: now,
        accessedAt: now,
        score: 1.0,
      };

      await manager.addRule(rule);

      // 写入存储
      const stored = storage.getById('rule:test');
      expect(stored).not.toBeNull();
      expect(stored!.content).toBe('测试规则内容');

      // 注入 system 消息
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]).toContain('【项目规则】测试规则');
      expect(systemMessages[0]).toContain('测试规则内容');
    });

    it('应拒绝 source 不为 rule 的记忆', async () => {
      const now = new Date().toISOString();
      const badMem: Memory = {
        id: 'persona:bad',
        content: 'xx',
        source: SOURCE_LABELS.PERSONA,
        name: '不该出现',
        createdAt: now,
        accessedAt: now,
        score: 1,
      };

      await expect(manager.addRule(badMem)).rejects.toThrow(/无效来源/);
    });
  });

  // ─── addSimpleRule ───────────────────────────────────

  describe('addSimpleRule', () => {
    it('应自动填充 id / source / score 等字段', async () => {
      await manager.addSimpleRule('简洁规则', '规则正文');

      const stored = storage.getById('rule:简洁规则');
      expect(stored).not.toBeNull();
      expect(stored!.source).toBe(SOURCE_LABELS.RULE);
      expect(stored!.name).toBe('简洁规则');
      expect(stored!.content).toBe('规则正文');
      expect(stored!.score).toBe(0.8);
      expect(stored!.createdAt).toBeDefined();
      expect(stored!.accessedAt).toBeDefined();
    });

    it('应注入 system 消息', async () => {
      await manager.addSimpleRule('简洁规则', '规则正文');

      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]).toContain('【项目规则】简洁规则');
    });
  });

  // ─── addSkill ────────────────────────────────────────

  describe('addSkill', () => {
    it('应成功添加 skill 记忆并注册到 SkillManager', async () => {
      const now = new Date().toISOString();
      const skill: Memory = {
        id: 'skill:test',
        content: '测试技能内容',
        source: SOURCE_LABELS.SKILL,
        name: '测试技能',
        createdAt: now,
        accessedAt: now,
        score: 0.7,
      };

      await manager.addSkill(skill);

      // 写入存储
      const stored = storage.getById('skill:test');
      expect(stored).not.toBeNull();
      expect(stored!.content).toBe('测试技能内容');

      // 注册到 SkillManager
      const entry = skillManager.get('测试技能');
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe('测试技能');
      expect(entry!.content).toBe('测试技能内容');
    });

    it('应拒绝 source 不为 skill 的记忆', async () => {
      const now = new Date().toISOString();
      const badMem: Memory = {
        id: 'rule:bad',
        content: 'xx',
        source: SOURCE_LABELS.RULE,
        name: '不该出现',
        createdAt: now,
        accessedAt: now,
        score: 1,
      };

      await expect(manager.addSkill(badMem)).rejects.toThrow(/无效来源/);
    });
  });

  // ─── addSimpleSkill ──────────────────────────────────

  describe('addSimpleSkill', () => {
    it('应自动填充 id / source / score 等字段', async () => {
      await manager.addSimpleSkill('简洁技能', '技能正文');

      const stored = storage.getById('skill:简洁技能');
      expect(stored).not.toBeNull();
      expect(stored!.source).toBe(SOURCE_LABELS.SKILL);
      expect(stored!.name).toBe('简洁技能');
      expect(stored!.content).toBe('技能正文');
      expect(stored!.score).toBe(0.7);
      expect(stored!.createdAt).toBeDefined();
      expect(stored!.accessedAt).toBeDefined();
    });

    it('应注册到 SkillManager', async () => {
      await manager.addSimpleSkill('简洁技能', '技能正文');

      const entry = skillManager.get('简洁技能');
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe('简洁技能');
    });
  });

  // ─── onConfigSuggestion / suggestionCallback ───────────────

  describe('onConfigSuggestion / suggestionCallback', () => {
    it('应注册并获取回调', () => {
      expect(manager.suggestionCallback).toBeNull();

      const handler = (_s: ConfigSuggestion) => {};
      manager.onConfigSuggestion(handler);

      expect(manager.suggestionCallback).toBe(handler);
    });

    it('多次注册应覆盖前一次', () => {
      const handler1 = (_s: ConfigSuggestion) => {};
      const handler2 = (_s: ConfigSuggestion) => {};

      manager.onConfigSuggestion(handler1);
      expect(manager.suggestionCallback).toBe(handler1);

      manager.onConfigSuggestion(handler2);
      expect(manager.suggestionCallback).toBe(handler2);
    });
  });

  // ─── confirmConfigSuggestion ─────────────────────────────────────────

  describe('confirmConfigSuggestion', () => {
    it('writeConfigFile 未设置时应抛错', async () => {
      const suggestion: ConfigSuggestion = {
        type: 'rule',
        name: '测试建议',
        content: '建议内容',
        confidence: 0.9,
      };

      await expect(manager.confirmConfigSuggestion(suggestion)).rejects.toThrow(/writeConfigFile 未设置/);
    });

    it('writeConfigFile 已设置时应调用写入回调', async () => {
      const written: Memory[] = [];
      const managerWithWrite = new ConfigManager({
        index: storage,
        skillManager,
        injectSystemMessage: (msg) => { systemMessages.push(msg); },
        refreshBootstrapMemories: vi.fn(),
        writeConfigFile: async (memory) => { written.push(memory); },
      });

      const suggestion: ConfigSuggestion = {
        type: 'rule',
        name: '持久化规则',
        content: '规则内容',
        confidence: 0.85,
      };

      await managerWithWrite.confirmConfigSuggestion(suggestion);

      // 写入回调被调用
      expect(written).toHaveLength(1);
      expect(written[0]!.source).toBe(SOURCE_LABELS.RULE);
      expect(written[0]!.name).toBe('持久化规则');
      expect(written[0]!.score).toBe(0.85);

      // rule 类型应同时注入 system 消息
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]).toContain('【项目规则】持久化规则');
    });

    it('persona 类型 confirmConfigSuggestion 不应注入 system 消息', async () => {
      const written: Memory[] = [];
      const managerWithWrite = new ConfigManager({
        index: storage,
        skillManager,
        injectSystemMessage: (msg) => { systemMessages.push(msg); },
        refreshBootstrapMemories: vi.fn(),
        writeConfigFile: async (memory) => { written.push(memory); },
      });

      const suggestion: ConfigSuggestion = {
        type: 'persona',
        name: '新角色',
        content: '角色描述',
        confidence: 0.9,
      };

      await managerWithWrite.confirmConfigSuggestion(suggestion);

      expect(written).toHaveLength(1);
      expect(written[0]!.source).toBe(SOURCE_LABELS.PERSONA);
      // persona 类型不注入 system 消息
      expect(systemMessages).toHaveLength(0);
    });

    it('rule 类型 confirmConfigSuggestion 应刷新 bootstrap 段（T2 防回归）', async () => {
      const refreshSpy = vi.fn();
      const managerWithWrite = new ConfigManager({
        index: storage,
        skillManager,
        injectSystemMessage: () => {},
        refreshBootstrapMemories: refreshSpy,
        writeConfigFile: async () => {},
      });

      await managerWithWrite.confirmConfigSuggestion({
        type: 'rule',
        name: 'T2规则',
        content: '规则内容',
        confidence: 0.8,
      });

      // 修复前（缺调用）：refreshSpy 未被调 → 断言红。
      // 修复后：新规则已 upsert 进索引，refreshBootstrapMemories 替换式重建 bootstrap 段。
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('同名已软删规则重建应复活索引而非抛错（T2-4 回归）', async () => {
      const now = new Date().toISOString();
      // 预置一条同名、已软删除的 rule 记忆（模拟「用户删过该规则后又确认同名建议」）
      storage.upsert({
        id: 'rule:同名规则',
        content: '旧内容（应被覆盖）',
        source: SOURCE_LABELS.RULE,
        name: '同名规则',
        createdAt: now,
        accessedAt: now,
        score: 1,
        deletedAt: now, // 软删除态
      });
      expect(storage.getDeletedById('rule:同名规则')).not.toBeNull();

      const written: Memory[] = [];
      const managerWithWrite = new ConfigManager({
        index: storage,
        skillManager,
        injectSystemMessage: () => {},
        refreshBootstrapMemories: vi.fn(),
        writeConfigFile: async (memory) => { written.push(memory); },
      });

      const suggestion: ConfigSuggestion = {
        type: 'rule',
        name: '同名规则',
        content: '新内容（重建）',
        confidence: 0.8,
      };

      // 修复前（缺 restore）：upsert 会因「以活跃态覆盖软删除态」抛错，而磁盘已在上方写入 → 半成功分叉。
      // 修复后：先 restore 再 upsert，索引复活、内容覆盖、无抛错。
      await expect(managerWithWrite.confirmConfigSuggestion(suggestion)).resolves.toBeUndefined();

      const revived = storage.getById('rule:同名规则');
      expect(revived).not.toBeNull();
      expect(revived!.deletedAt).toBeUndefined(); // 已复活
      expect(revived!.content).toBe('新内容（重建）'); // 内容被新建议覆盖
      expect(written).toHaveLength(1);
      expect(written[0]!.id).toBe('rule:同名规则');
    });

    it('suggestion.name 含路径穿越字符应被白名单拒绝（T2-4 回归）', async () => {
      const managerWithWrite = new ConfigManager({
        index: storage,
        skillManager,
        injectSystemMessage: () => {},
        refreshBootstrapMemories: vi.fn(),
        writeConfigFile: async () => {},
      });

      // 路径穿越面：'..' 可逃出 configDir；'a/b' 越级进子目录；空格/空串亦不在白名单内
      for (const badName of ['../escape', 'a/b', '..\\win', 'name with space', '']) {
        await expect(
          managerWithWrite.confirmConfigSuggestion({
            type: 'rule',
            name: badName,
            content: 'x',
            confidence: 0.5,
          }),
        ).rejects.toThrow(/配置建议名称非法/);
      }
    });

    it('persona 类型 confirmConfigSuggestion 不应刷新 bootstrap 段（T2 防过度修复）', async () => {
      const refreshSpy = vi.fn();
      const managerWithWrite = new ConfigManager({
        index: storage,
        skillManager,
        injectSystemMessage: () => {},
        refreshBootstrapMemories: refreshSpy,
        writeConfigFile: async () => {},
      });

      await managerWithWrite.confirmConfigSuggestion({
        type: 'persona',
        name: '新角色',
        content: '角色描述',
        confidence: 0.8,
      });

      // persona 走 reloadConfig 路径（agent.reloadConfig('persona')），bootstrap 刷新是 rule 专属
      expect(refreshSpy).not.toHaveBeenCalled();
    });
  });

  // ─── T2-3（F3-2）删除死回调后的失败降级 ──────────────────
  // 根因：onBootstrapSyncFailed 定义完善但全仓零注册（死契约），失败可观测性已由
  // logger.warn 承担（宿主日志链路消费）。删除该回调后，必须证明失败降级契约未退化：
  // safeRefreshBootstrapMemories 吞掉 refreshBootstrapMemories 的异常、不向外抛出、
  // 且经 logger.warn 暴露。此测试绑定两类回归——误删 try/catch（会抛 → 红）、误删 warn（调用 0 → 红）。
  describe('safeRefreshBootstrapMemories（T2-3 删除死回调后失败降级）', () => {
    it('refreshBootstrapMemories 抛错时不应抛出，且通过 logger.warn 暴露（无死回调分支）', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const managerWithFailingRefresh = new ConfigManager({
        index: storage,
        skillManager,
        injectSystemMessage: (msg) => { systemMessages.push(msg); },
        refreshBootstrapMemories: () => { throw new Error('simulated bootstrap desync'); },
      });

      expect(() =>
        (managerWithFailingRefresh as unknown as { safeRefreshBootstrapMemories(): void })
          .safeRefreshBootstrapMemories(),
      ).not.toThrow();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [meta, msg] = warnSpy.mock.calls[0]!;
      expect(String(msg)).toContain('bootstrap 记忆同步失败');
      expect((meta as { err?: Error }).err?.message).toBe('simulated bootstrap desync');
      warnSpy.mockRestore();
    });
  });
});
