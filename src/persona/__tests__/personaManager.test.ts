/**
 * PersonaManager 单元测试
 *
 * 测试范围：
 *   - 角色文件解析（frontmatter + content）
 *   - 多角色加载与选择
 *   - 加载失败降级（默认角色兜底）
 *   - system prompt 组装
 *   - 角色切换
 *
 * 注意：PersonaManager 使用 readFileSync 同步读取，
 * 测试中必须用 writeFileSync 同步写入文件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PersonaManager } from '../personaManager.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 辅助函数：创建角色文件
 */
const createPersonaFile = (dir: string, filename: string, content: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf-8');
};

describe('PersonaManager', () => {
  let testDir: string;
  let personasDir: string;
  /** 不存在的全局目录，防止扫描真实 ~/.memora/global/personas/ */
  let fakeGlobalDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `memora-test-persona-${Date.now()}`);
    personasDir = join(testDir, 'personas');
    mkdirSync(personasDir, { recursive: true });
    fakeGlobalDir = join(testDir, 'fake-global-personas');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('应该加载单个角色文件', () => {
      // Given
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
description: 通用AI助手
---

# 默认助手

你是一个通用AI助手，擅长回答各种问题。`,
      );

      const personaManager = new PersonaManager(testDir, fakeGlobalDir);

      // When
      const result = personaManager.load();

      // Then
      expect(result).toContain('默认助手');
      expect(result).toContain('你是一个通用AI助手');
    });

    it('应该加载指定角色', () => {
      // Given
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
description: 通用AI助手
---

你是一个通用AI助手。`,
      );

      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
description: 专业编程助手
---

你是一个专业编程助手，擅长代码审查和架构设计。`,
      );

      const personaManager = new PersonaManager(testDir, fakeGlobalDir);

      // When
      const result = personaManager.load('coder');

      // Then
      expect(result).toContain('程序员助手');
      expect(result).toContain('专业编程助手');
      expect(result).not.toContain('通用AI助手');
    });

    it('应该在角色文件不存在时降级到默认角色', () => {
      // Given - 空目录 + 不存在的全局目录
      const personaManager = new PersonaManager(testDir, fakeGlobalDir);

      // When
      const result = personaManager.load('nonexistent');

      // Then - 降级到默认角色，不返回空字符串
      expect(result).toContain('default');
      expect(result).toContain('通用 AI 助手');
    });

    it('应该在目录不存在时降级到默认角色', () => {
      // Given
      const nonExistentDir = join(testDir, 'nonexistent');
      const personaManager = new PersonaManager(nonExistentDir, fakeGlobalDir);

      // When
      const result = personaManager.load();

      // Then - 降级到默认角色
      expect(result).toContain('default');
    });
  });

  describe('角色列表', () => {
    it('应该通过 list getter 列出所有可用角色', () => {
      // Given
      createPersonaFile(
        personasDir,
        'persona1.md',
        `---
name: 角色1
---
内容1`,
      );

      createPersonaFile(
        personasDir,
        'persona2.md',
        `---
name: 角色2
---
内容2`,
      );

      const personaManager = new PersonaManager(testDir, fakeGlobalDir);
      personaManager.load();

      // When
      const personas = personaManager.list;

      // Then
      expect(personas).toHaveLength(2);
      expect(personas.some((p) => p.name === '角色1')).toBe(true);
      expect(personas.some((p) => p.name === '角色2')).toBe(true);
    });

    it('应该在目录为空时返回空列表（降级到默认角色）', () => {
      // Given - 空目录
      const personaManager = new PersonaManager(testDir, fakeGlobalDir);
      personaManager.load();

      // When
      const personas = personaManager.list;

      // Then - personaList 为空（默认角色不加入 list）
      expect(personas).toHaveLength(0);
    });
  });

  describe('角色切换', () => {
    it('应该支持运行时切换角色', () => {
      // Given
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
---
你是一个通用AI助手。`,
      );

      createPersonaFile(
        personasDir,
        'coder.md',
        `---
name: 程序员助手
---
你是一个专业编程助手。`,
      );

      const personaManager = new PersonaManager(testDir, fakeGlobalDir);
      personaManager.load('default');

      // When
      const result = personaManager.switchPersona('coder');

      // Then
      expect(result).toContain('程序员助手');
      expect(personaManager.active?.name).toBe('程序员助手');
    });

    it('应该在切换到不存在的角色时保持当前角色', () => {
      // Given
      createPersonaFile(
        personasDir,
        'default.md',
        `---
name: 默认助手
---
你是一个通用AI助手。`,
      );

      const personaManager = new PersonaManager(testDir, fakeGlobalDir);
      personaManager.load('default');

      // When
      const result = personaManager.switchPersona('nonexistent');

      // Then - 保持当前角色
      expect(result).toContain('默认助手');
      expect(personaManager.active?.name).toBe('默认助手');
    });
  });

  describe('错误处理', () => {
    it('应该跳过格式错误的文件，加载有效文件', () => {
      // Given
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
---
有效内容`,
      );

      const personaManager = new PersonaManager(testDir, fakeGlobalDir);

      // When - load 不会因为 invalid 文件而崩溃
      const result = personaManager.load();

      // Then - 至少能加载成功
      expect(result).toBeTruthy();
    });
  });
});
