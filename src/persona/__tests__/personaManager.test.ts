/**
 * PersonaManager 单元测试 (v1.1 API)
 *
 * 测试范围：
 *   - 角色文件解析（frontmatter + content）
 *   - 多角色加载与选择（async load）
 *   - 加载失败降级（默认角色兜底）
 *   - system prompt 组装（【当前角色】格式）
 *   - 角色切换（时间窗口缓冲）
 *   - 关键词自动匹配（autoMatch）
 *   - 模式切换（setMode / currentMode）
 *   - activeName getter
 *
 * 注意：PersonaManager v1.1 扫描 <configDir>/personas/*.md，
 * 测试中目录名必须为 personas。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersonaManager } from '@/persona/personaManager.js';
import type { Persona } from '@/persona/types.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 辅助函数：在指定目录创建角色文件（.md）
 */
const createPersonaFile = (dir: string, filename: string, content: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf-8');
};

describe('PersonaManager (v1.1)', () => {
  let testDir: string;
  /** 项目级角色目录：<testDir>/personas/ */
  let personasDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `memora-test-persona-${Date.now()}`);
    personasDir = join(testDir, 'personas');
    mkdirSync(personasDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════
  // load（async）
  // ════════════════════════════════════════════════════════
  describe('load', () => {
    it('应该异步加载单个角色文件并返回 system prompt', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
description: 通用AI助手
keywords: 通用, 助手
---

# 默认助手

你是一个通用AI助手，擅长回答各种问题。`,
      );

      const personaManager = new PersonaManager(testDir);

      const result = await personaManager.load();

      expect(result).toContain('默认助手');
      expect(result).toContain('你是一个通用AI助手');
    });

    it('应该加载指定角色（by name）', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
description: 通用AI助手
keywords: 通用
---

你是一个通用AI助手。`,
      );

      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
description: 专业编程助手
keywords: 编程, 代码, 架构
---

你是一个专业编程助手，擅长代码审查和架构设计。`,
      );

      const personaManager = new PersonaManager(testDir);

      const result = await personaManager.load('coder');

      expect(result).toContain('程序员助手');
      expect(result).toContain('专业编程助手');
      expect(result).not.toContain('通用AI助手');
    });

    it('应该在角色文件不存在时降级到默认角色', async () => {
      const personaManager = new PersonaManager(testDir);

      const result = await personaManager.load('nonexistent');

      expect(result).toContain('default');
      expect(result).toContain('通用 AI 助手');
    });

    it('应该在 personas 目录不存在时降级到默认角色', async () => {
      const nonExistentDir = join(testDir, 'nonexistent');
      const personaManager = new PersonaManager(nonExistentDir);

      const result = await personaManager.load();

      expect(result).toContain('default');
      expect(result).toContain('通用 AI 助手');
    });

    it('加载后 activeName 应返回当前角色名', async () => {
      createPersonaFile(
        personasDir,
        'helper.md',
        `---
name: 小助手
keywords: 帮助
---
我是你的小助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load();

      expect(personaManager.activeName).toBe('小助手');
    });

    it('未加载任何角色时 activeName 应返回 "default"', () => {
      const personaManager = new PersonaManager(testDir);

      expect(personaManager.activeName).toBe('default');
    });
  });

  // ════════════════════════════════════════════════════════
  // 角色列表
  // ════════════════════════════════════════════════════════
  describe('角色列表', () => {
    it('应该通过 list getter 列出所有可用角色', async () => {
      createPersonaFile(
        personasDir,
        'persona1.md',
        `---
name: 角色1
keywords: k1
---
内容1`,
      );

      createPersonaFile(
        personasDir,
        'persona2.md',
        `---
name: 角色2
keywords: k2
---
内容2`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load();

      const personas = personaManager.list;

      expect(personas).toHaveLength(2);
      expect(personas.some((p: Persona) => p.name === '角色1')).toBe(true);
      expect(personas.some((p: Persona) => p.name === '角色2')).toBe(true);
    });

    it('应该在目录为空时返回空列表（降级到默认角色）', async () => {
      const personaManager = new PersonaManager(testDir);
      await personaManager.load();

      const personas = personaManager.list;

      // personaList 为空（默认角色不加入 list）
      expect(personas).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════
  // system prompt 组装
  // ════════════════════════════════════════════════════════
  describe('buildSystemPrompt', () => {
    it('应该包含【当前角色】标记', async () => {
      createPersonaFile(
        personasDir,
        'helper.md',
        `---
name: 小助手
description: 乐于助人
keywords: 帮助
---
我是你的小助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load();

      const prompt = personaManager.buildSystemPrompt();

      expect(prompt).toContain('【当前角色】');
      expect(prompt).toContain('小助手');
      expect(prompt).toContain('乐于助人');
      expect(prompt).toContain('我是你的小助手。');
    });

    it('未激活角色时 buildSystemPrompt 应返回空字符串', () => {
      const personaManager = new PersonaManager(testDir);

      const prompt = personaManager.buildSystemPrompt();

      expect(prompt).toBe('');
    });

    it('buildSystemPrompt(name) 应按名称构建指定角色的 prompt', async () => {
      createPersonaFile(
        personasDir,
        'a.md',
        `---
name: 角色A
keywords: a
---
AAA`,
      );
      createPersonaFile(
        personasDir,
        'b.md',
        `---
name: 角色B
keywords: b
---
BBB`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('角色A');

      const promptB = personaManager.buildSystemPrompt('角色B');

      expect(promptB).toContain('角色B');
      expect(promptB).toContain('BBB');
      expect(promptB).not.toContain('角色A');
    });
  });

  // ════════════════════════════════════════════════════════
  // 角色切换
  // ════════════════════════════════════════════════════════
  describe('角色切换', () => {
    it('应该支持运行时切换角色', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
keywords: 通用
---
你是一个通用AI助手。`,
      );

      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
keywords: 编程, 代码
---
你是一个专业编程助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      const result = personaManager.switchPersona('程序员助手');

      expect(result).toContain('程序员助手');
      expect(personaManager.getActive()?.name).toBe('程序员助手');
    });

    it('应该在切换到不存在的角色时抛出 MemoraError', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
keywords: 通用
---
你是一个通用AI助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      // 统一错误策略：找不到角色时抛错，与 switchProject 一致
      expect(() => personaManager.switchPersona('nonexistent')).toThrow('角色切换失败');
      expect(personaManager.getActive()?.name).toBe('默认助手');
    });

    it('切换到相同角色应直接返回当前 prompt', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
keywords: 通用
---
你是一个通用AI助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      const result = personaManager.switchPersona('默认助手');

      expect(result).toContain('默认助手');
    });
  });

  // ════════════════════════════════════════════════════════
  // 角色切换锁定状态（P0-2 用户体验打磨）
  // ════════════════════════════════════════════════════════
  describe('角色切换锁定状态 (P0-2)', () => {
    it('未锁定时 getSwitchLockStatus 应返回 locked=false + unlockAt=null', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
---
你是一个通用AI助手。`,
      );
      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      const status = personaManager.getSwitchLockStatus();
      expect(status).toEqual({ locked: false, unlockAt: null });
    });

    it('30s 内切换 5 次后应锁定并记录 unlockAt', async () => {
      // 创建 6 个角色用于频繁切换测试
      for (const name of ['角色A', '角色B', '角色C', '角色D', '角色E', '角色F']) {
        createPersonaFile(
          personasDir,
          `${name}.md`,
          `---
name: ${name}
---
${name}内容`,
        );
      }
      const personaManager = new PersonaManager(testDir);
      await personaManager.load('角色A');
      // 用 vi.useFakeTimers 控制 AUTO_UNLOCK_MS 定时器
      vi.useFakeTimers();
      const now = Date.now();
      try {
        // 5 次切换触发锁定（第 5 次 recordSwitch 时 length >= 5）
        personaManager.switchPersona('角色B');
        personaManager.switchPersona('角色C');
        personaManager.switchPersona('角色D');
        personaManager.switchPersona('角色E');
        personaManager.switchPersona('角色F');

        // 锁定后 getSwitchLockStatus 应返回 locked=true + unlockAt ≈ now + 120000
        const status = personaManager.getSwitchLockStatus();
        expect(status.locked).toBe(true);
        expect(status.unlockAt).toBeGreaterThan(now);
        // unlockAt 应在 now+120000 附近（允许 1 秒误差）
        expect(status.unlockAt! - now).toBeGreaterThanOrEqual(119_000);
        expect(status.unlockAt! - now).toBeLessThanOrEqual(121_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('setMode(auto) 解除锁定时应同步清空 unlockAt', async () => {
      for (const name of ['角色A', '角色B', '角色C', '角色D', '角色E', '角色F']) {
        createPersonaFile(
          personasDir,
          `${name}.md`,
          `---
name: ${name}
---
${name}内容`,
        );
      }
      const personaManager = new PersonaManager(testDir);
      await personaManager.load('角色A');
      vi.useFakeTimers();
      try {
        personaManager.switchPersona('角色B');
        personaManager.switchPersona('角色C');
        personaManager.switchPersona('角色D');
        personaManager.switchPersona('角色E');
        personaManager.switchPersona('角色F');
        expect(personaManager.getSwitchLockStatus().locked).toBe(true);

        // 切到 manual 再切回 auto 解除锁定
        personaManager.setMode('manual');
        personaManager.setMode('auto');

        // unlockAt 应被同步清空（P0-2 排雷雷点 4）
        const status = personaManager.getSwitchLockStatus();
        expect(status).toEqual({ locked: false, unlockAt: null });
      } finally {
        vi.useRealTimers();
      }
    });

    it('close() 应清空锁定状态字段（避免脏数据，P0-2 排雷雷点 5）', async () => {
      for (const name of ['角色A', '角色B', '角色C', '角色D', '角色E', '角色F']) {
        createPersonaFile(
          personasDir,
          `${name}.md`,
          `---
name: ${name}
---
${name}内容`,
        );
      }
      const personaManager = new PersonaManager(testDir);
      await personaManager.load('角色A');
      vi.useFakeTimers();
      try {
        personaManager.switchPersona('角色B');
        personaManager.switchPersona('角色C');
        personaManager.switchPersona('角色D');
        personaManager.switchPersona('角色E');
        personaManager.switchPersona('角色F');
        expect(personaManager.getSwitchLockStatus().locked).toBe(true);

        personaManager.close();

        // close 后所有锁定字段应清空
        expect(personaManager.getSwitchLockStatus()).toEqual({ locked: false, unlockAt: null });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ════════════════════════════════════════════════════════
  // autoMatch（v1.1 新增）
  // ════════════════════════════════════════════════════════
  describe('autoMatch', () => {
    it('应该根据输入关键词自动匹配角色', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
keywords: 通用
---
通用助手。`,
      );
      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
keywords: 编程, 代码, TypeScript
---
专业编程助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      // 用户输入包含编程关键词
      const matched = await personaManager.autoMatch('帮我写一段 TypeScript 代码');

      expect(matched).toBe('程序员助手');
    });

    it('无匹配时应返回 null', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
keywords: 通用
---
通用助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      // 关键词命中率太低
      const matched = await personaManager.autoMatch('今天天气怎么样');

      expect(matched).toBeNull();
    });

    it('manual 模式下应始终返回 null', async () => {
      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
keywords: 编程, 代码
---
专业编程助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('程序员助手');
      personaManager.setMode('manual');

      // manual 模式下 autoMatch 直接返回 null（Promise）→ 需 await
      const matched = await personaManager.autoMatch('帮我写代码');

      expect(matched).toBeNull();
    });

    it('匹配的角色与当前角色相同时应返回 null', async () => {
      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
keywords: 编程, 代码
---
专业编程助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('程序员助手');

      const matched = await personaManager.autoMatch('帮我写代码');

      expect(matched).toBeNull();
    });

    it('关键词命中 ≥ 0.3（高置信度阈值）时应返回匹配角色', async () => {
      // 阈值 0.3：4 个关键词命中 1 个 → 1/min(4,3)=1/3≈0.33 ≥ 0.3 → 高置信度命中
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
keywords: 通用
---
你是一个通用AI助手。`,
      );
      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
keywords: 编程, 代码, 架构, 设计
---
专业编程助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      // 当前激活"默认助手"，输入匹配"程序员助手"的关键词
      // 4 个关键词中只命中 1 个（"代码"）→ score = 1/min(4,3) = 0.33 ≥ 0.3
      const matched = await personaManager.autoMatch('帮我写代码');

      expect(matched).toBe('程序员助手');
    });

    it('关键词全部不命中时应返回 null', async () => {
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
keywords: 通用
---
你是一个通用AI助手。`,
      );
      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
keywords: 编程, 代码, 架构, 设计
---
专业编程助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load('默认助手');

      // 输入与关键词完全无关 → score = 0 < 0.3
      const matched = await personaManager.autoMatch('今天天气不错');

      expect(matched).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════
  // setMode / currentMode（v1.1 新增）
  // ════════════════════════════════════════════════════════
  describe('模式切换', () => {
    it('默认模式应为 auto', () => {
      const personaManager = new PersonaManager(testDir);

      expect(personaManager.currentMode).toBe('auto');
    });

    it('setMode 应切换模式', () => {
      const personaManager = new PersonaManager(testDir);

      personaManager.setMode('manual');
      expect(personaManager.currentMode).toBe('manual');

      personaManager.setMode('auto');
      expect(personaManager.currentMode).toBe('auto');
    });
  });

  // ════════════════════════════════════════════════════════
  // getActive
  // ════════════════════════════════════════════════════════
  describe('getActive', () => {
    it('未加载时 getActive 应为 null', () => {
      const personaManager = new PersonaManager(testDir);

      expect(personaManager.getActive()).toBeNull();
    });

    it('加载后 getActive 应返回当前激活的 Persona', async () => {
      createPersonaFile(
        personasDir,
        'helper.md',
        `---
name: 小助手
keywords: 帮助
---
我是小助手。`,
      );

      const personaManager = new PersonaManager(testDir);
      await personaManager.load();

      const active = personaManager.getActive();

      expect(active).not.toBeNull();
      expect(active!.name).toBe('小助手');
      expect(active!.id).toBeTruthy();
    });
  });

  // ════════════════════════════════════════════════════════
  // 错误处理
  // ════════════════════════════════════════════════════════
  describe('错误处理', () => {
    it('应该跳过格式错误的文件，加载有效文件', async () => {
      createPersonaFile(
        personasDir,
        'invalid.md',
        `---
name: [unclosed
---
无效内容`,
      );

      createPersonaFile(
        personasDir,
        'valid.md',
        `---
name: 有效角色
keywords: 有效
---
有效内容`,
      );

      const personaManager = new PersonaManager(testDir);

      // load 不会因为 invalid 文件而崩溃
      const result = await personaManager.load();

      expect(result).toBeTruthy();
    });
  });

  // ════════════════════════════════════════════════════════
  // reload（事件驱动热重载）
  // ════════════════════════════════════════════════════════

  describe('reload', () => {
    it('重载应反映目录变更（新增角色）且保持激活角色', async () => {
      createPersonaFile(personasDir, 'default.md', '---\nname: default\n---\n默认角色内容');
      const personaManager = new PersonaManager(testDir);
      await personaManager.load('default');
      expect(personaManager.list).toHaveLength(1);
      expect(personaManager.activeName).toBe('default');

      // 新增第 2 个角色
      createPersonaFile(personasDir, 'coder.md', '---\nname: coder\nkeywords: 代码\n---\n程序员角色');
      const count = await personaManager.reload();

      expect(count).toBe(2);
      expect(personaManager.list).toHaveLength(2);
      // 激活角色应保持为 default
      expect(personaManager.activeName).toBe('default');
    });

    it('重载后激活角色被删除应回退到第一个', async () => {
      createPersonaFile(personasDir, 'default.md', '---\nname: default\n---\n默认角色');
      createPersonaFile(personasDir, 'coder.md', '---\nname: coder\n---\n程序员角色');
      const personaManager = new PersonaManager(testDir);
      await personaManager.load('coder');
      expect(personaManager.activeName).toBe('coder');

      // 删除激活的 coder 角色文件
      rmSync(join(personasDir, 'coder.md'));
      await personaManager.reload();

      // 激活角色应回退到列表第一个（default）
      expect(personaManager.activeName).toBe('default');
    });

    it('重载应反映内容变更', async () => {
      createPersonaFile(personasDir, 'default.md', '---\nname: default\n---\n旧内容');
      const personaManager = new PersonaManager(testDir);
      await personaManager.load('default');
      expect(personaManager.getActive()?.content).toBe('旧内容');

      // 修改角色文件内容
      createPersonaFile(personasDir, 'default.md', '---\nname: default\n---\n新内容');
      await personaManager.reload();
      expect(personaManager.getActive()?.content).toBe('新内容');
    });
  });
});
