/**
 * shared/inputValidation.ts 单元测试（P0 安全白名单真理源）
 *
 * 覆盖范围：
 * - isValidSessionName / isValidConfigName：名称白名单（防路径遍历）
 * - isValidContent：内容长度上限（防内存耗尽）
 * - isValidId：记忆 ID 校验
 * - isValidSearchQuery：搜索关键词校验
 * - isValidPersonaName：角色名 ASCII 白名单
 * - isValidFilePath：文件路径长度校验
 * - isValidRelationType / isValidRelationParams：关系类型白名单
 * - isNonEmptyString：通用非空校验
 * - isValidShortcutConfig：快捷键配置类型守卫
 *
 * 与 electron/ipc/inputValidation.test.ts 的区别：
 * - IPC 测试覆盖 re-export + isPathAllowed（依赖 node:path）
 * - 本测试直接锁定 shared/ 真理源的纯函数行为，防止 re-export 链断裂后行为无人守护
 */
import { describe, it, expect } from 'vitest';
import {
  isValidSessionName,
  isValidConfigName,
  isValidContent,
  isValidId,
  isValidSearchQuery,
  isValidPersonaName,
  isValidFilePath,
  isValidRelationType,
  isValidRelationParams,
  isNonEmptyString,
  isValidShortcutConfig,
} from '../../shared/inputValidation.js';

// ─── isValidSessionName / isValidConfigName ──────────────

describe('isValidSessionName / isValidConfigName', () => {
  it('纯字母应通过', () => {
    expect(isValidSessionName('main')).toBe(true);
    expect(isValidConfigName('rules')).toBe(true);
  });

  it('含中文应通过（Unicode 字母白名单）', () => {
    expect(isValidSessionName('程序员助手')).toBe(true);
    expect(isValidConfigName('角色配置')).toBe(true);
  });

  it('含数字和连字符应通过', () => {
    expect(isValidSessionName('session-123')).toBe(true);
    expect(isValidConfigName('config_001')).toBe(true);
  });

  it('路径分隔符应拒绝（防路径遍历）', () => {
    expect(isValidSessionName('a/b')).toBe(false);
    expect(isValidSessionName('a\\b')).toBe(false);
    expect(isValidConfigName('../etc')).toBe(false);
    expect(isValidConfigName('..\\passwd')).toBe(false);
  });

  it('点号应拒绝（防 .. 遍历）', () => {
    expect(isValidSessionName('a.b')).toBe(false);
    expect(isValidConfigName('.env')).toBe(false);
  });

  it('空格应拒绝', () => {
    expect(isValidSessionName('a b')).toBe(false);
    expect(isValidConfigName('a b')).toBe(false);
  });

  it('空字符串或 null 应拒绝', () => {
    expect(isValidSessionName('')).toBe(false);
    expect(isValidConfigName('')).toBe(false);
    expect(isValidSessionName(null as unknown as string)).toBe(false);
  });

  it('超长名称应拒绝（>200 字符）', () => {
    const long = 'a'.repeat(201);
    expect(isValidSessionName(long)).toBe(false);
    expect(isValidConfigName(long)).toBe(false);
  });

  it('恰好 200 字符应通过', () => {
    const exact = 'a'.repeat(200);
    expect(isValidSessionName(exact)).toBe(true);
  });
});

// ─── isValidContent ──────────────────────────────────────

describe('isValidContent', () => {
  it('正常内容应通过', () => {
    expect(isValidContent('hello world')).toBe(true);
  });

  it('空字符串应拒绝', () => {
    expect(isValidContent('')).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isValidContent(null as unknown as string)).toBe(false);
    expect(isValidContent(123 as unknown as string)).toBe(false);
    expect(isValidContent(undefined as unknown as string)).toBe(false);
  });

  it('超过默认上限 10MB 应拒绝', () => {
    const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
    expect(isValidContent(huge)).toBe(false);
  });

  it('恰好 10MB 应通过', () => {
    const exact = 'x'.repeat(10 * 1024 * 1024);
    expect(isValidContent(exact)).toBe(true);
  });

  it('自定义上限应生效', () => {
    expect(isValidContent('hello', 3)).toBe(false);
    expect(isValidContent('hel', 3)).toBe(true);
  });
});

// ─── isValidId ───────────────────────────────────────────

describe('isValidId', () => {
  it('正常 ID 应通过', () => {
    expect(isValidId('memory:用户偏好')).toBe(true);
    expect(isValidId('session:abc-123')).toBe(true);
  });

  it('空字符串应拒绝', () => {
    expect(isValidId('')).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isValidId(null as unknown as string)).toBe(false);
    expect(isValidId(123 as unknown as string)).toBe(false);
  });

  it('超长 ID 应拒绝（>500 字符）', () => {
    expect(isValidId('x'.repeat(501))).toBe(false);
  });

  it('恰好 500 字符应通过', () => {
    expect(isValidId('x'.repeat(500))).toBe(true);
  });
});

// ─── isValidSearchQuery ──────────────────────────────────

describe('isValidSearchQuery', () => {
  it('正常关键词应通过', () => {
    expect(isValidSearchQuery('记忆')).toBe(true);
  });

  it('空字符串应通过（触发全量召回）', () => {
    expect(isValidSearchQuery('')).toBe(true);
  });

  it('非字符串应拒绝', () => {
    expect(isValidSearchQuery(null as unknown as string)).toBe(false);
    expect(isValidSearchQuery(123 as unknown as string)).toBe(false);
  });

  it('超长关键词应拒绝（>1000 字符）', () => {
    expect(isValidSearchQuery('x'.repeat(1001))).toBe(false);
  });

  it('恰好 1000 字符应通过', () => {
    expect(isValidSearchQuery('x'.repeat(1000))).toBe(true);
  });
});

// ─── isValidPersonaName ──────────────────────────────────

describe('isValidPersonaName', () => {
  it('ASCII 字母+数字应通过', () => {
    expect(isValidPersonaName('coder')).toBe(true);
    expect(isValidPersonaName('helper-001')).toBe(true);
    expect(isValidPersonaName('my.persona')).toBe(true);
  });

  it('中文名应拒绝（persona 保持 ASCII 命名规范）', () => {
    expect(isValidPersonaName('程序员')).toBe(false);
  });

  it('路径分隔符应拒绝', () => {
    expect(isValidPersonaName('a/b')).toBe(false);
    expect(isValidPersonaName('a\\b')).toBe(false);
  });

  it('空格应拒绝', () => {
    expect(isValidPersonaName('a b')).toBe(false);
  });

  it('空字符串应拒绝', () => {
    expect(isValidPersonaName('')).toBe(false);
  });

  it('超长名称应拒绝（>100 字符）', () => {
    expect(isValidPersonaName('a'.repeat(101))).toBe(false);
  });

  it('恰好 100 字符应通过', () => {
    expect(isValidPersonaName('a'.repeat(100))).toBe(true);
  });
});

// ─── isValidFilePath ─────────────────────────────────────

describe('isValidFilePath', () => {
  it('正常路径应通过', () => {
    expect(isValidFilePath('/home/user/file.txt')).toBe(true);
    expect(isValidFilePath('C:\\Users\\test\\file.md')).toBe(true);
  });

  it('空字符串应拒绝', () => {
    expect(isValidFilePath('')).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isValidFilePath(null as unknown as string)).toBe(false);
  });

  it('超长路径应拒绝（>1000 字符）', () => {
    expect(isValidFilePath('x'.repeat(1001))).toBe(false);
  });
});

// ─── isValidRelationType ─────────────────────────────────

describe('isValidRelationType', () => {
  it('白名单内的 6 种关系应通过', () => {
    expect(isValidRelationType('contradicts')).toBe(true);
    expect(isValidRelationType('supports')).toBe(true);
    expect(isValidRelationType('follows')).toBe(true);
    expect(isValidRelationType('refines')).toBe(true);
    expect(isValidRelationType('caused')).toBe(true);
    expect(isValidRelationType('related')).toBe(true);
  });

  it('白名单外的关系应拒绝', () => {
    expect(isValidRelationType('custom')).toBe(false);
    expect(isValidRelationType('likes')).toBe(false);
  });

  it('空字符串应拒绝', () => {
    expect(isValidRelationType('')).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isValidRelationType(null as unknown as string)).toBe(false);
  });

  it('超长类型应拒绝（>50 字符）', () => {
    expect(isValidRelationType('x'.repeat(51))).toBe(false);
  });
});

// ─── isValidRelationParams ───────────────────────────────

describe('isValidRelationParams', () => {
  it('完整三元组应通过', () => {
    expect(isValidRelationParams({
      sourceId: 'memory:001',
      targetId: 'memory:002',
      type: 'supports',
    })).toBe(true);
  });

  it('null / undefined 应拒绝', () => {
    expect(isValidRelationParams(null)).toBe(false);
    expect(isValidRelationParams(undefined)).toBe(false);
  });

  it('sourceId 无效应拒绝', () => {
    expect(isValidRelationParams({
      sourceId: '',
      targetId: 'memory:002',
      type: 'supports',
    })).toBe(false);
  });

  it('targetId 无效应拒绝', () => {
    expect(isValidRelationParams({
      sourceId: 'memory:001',
      targetId: '',
      type: 'supports',
    })).toBe(false);
  });

  it('type 无效应拒绝', () => {
    expect(isValidRelationParams({
      sourceId: 'memory:001',
      targetId: 'memory:002',
      type: 'invalid',
    })).toBe(false);
  });
});

// ─── isNonEmptyString ────────────────────────────────────

describe('isNonEmptyString', () => {
  it('非空字符串应通过', () => {
    expect(isNonEmptyString('hello')).toBe(true);
    expect(isNonEmptyString(' ')).toBe(true);
  });

  it('空字符串应拒绝', () => {
    expect(isNonEmptyString('')).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(123)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
  });
});

// ─── isValidShortcutConfig ───────────────────────────────

describe('isValidShortcutConfig', () => {
  it('完整配置应通过并收窄类型', () => {
    const config = {
      enabled: true,
      accelerators: { 'toggle-window': 'Ctrl+Shift+M' },
    };
    expect(isValidShortcutConfig(config)).toBe(true);
    // 类型守卫验证：if 分支内 config 被收窄为 ShortcutConfig
    if (isValidShortcutConfig(config)) {
      expect(config.enabled).toBe(true);
      expect(config.accelerators['toggle-window']).toBe('Ctrl+Shift+M');
    }
  });

  it('enabled 为 false 应通过', () => {
    expect(isValidShortcutConfig({ enabled: false, accelerators: {} })).toBe(true);
  });

  it('null 应拒绝', () => {
    expect(isValidShortcutConfig(null)).toBe(false);
  });

  it('非对象应拒绝', () => {
    expect(isValidShortcutConfig('string')).toBe(false);
    expect(isValidShortcutConfig(123)).toBe(false);
  });

  it('enabled 非 boolean 应拒绝', () => {
    expect(isValidShortcutConfig({ enabled: 'true', accelerators: {} })).toBe(false);
  });

  it('accelerators 为数组应拒绝', () => {
    expect(isValidShortcutConfig({ enabled: true, accelerators: [] })).toBe(false);
  });

  it('accelerators 值非字符串应拒绝', () => {
    expect(isValidShortcutConfig({
      enabled: true,
      accelerators: { key: 123 },
    })).toBe(false);
  });

  it('accelerators 为 null 应拒绝', () => {
    expect(isValidShortcutConfig({ enabled: true, accelerators: null })).toBe(false);
  });
});
