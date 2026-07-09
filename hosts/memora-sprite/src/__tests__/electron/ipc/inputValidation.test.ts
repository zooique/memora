/**
 * IPC 输入验证工具测试
 *
 * 覆盖范围：
 * - isValidSessionName：会话名校验（白名单 + 长度）
 * - isValidConfigName：配置名校验（防路径遍历写入）
 * - isValidContent：内容长度校验（防内存耗尽）
 * - isValidId：记忆 ID 校验（类型 + 长度，FOUNDATION-SEAL Phase 3）
 * - isValidSearchQuery：搜索关键词校验（类型 + 长度，FOUNDATION-SEAL Phase 3）
 * - isPathAllowed：文件路径白名单校验（防路径遍历攻击）
 *
 * 这些函数是 IPC 安全边界，防止路径遍历、注入等安全风险。
 * 仅依赖 node:path，零 electron 依赖，纯逻辑测试。
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
  isPathAllowed,
} from '../../../electron/ipc/inputValidation.js';

// ─── isValidSessionName ──────────────────────────────────

describe('isValidSessionName', () => {
  // ─── 合法输入 ──────────────────────────────────────────

  it('纯字母应通过', () => {
    expect(isValidSessionName('main')).toBe(true);
  });

  it('字母+数字应通过', () => {
    expect(isValidSessionName('session123')).toBe(true);
  });

  it('含连字符应通过', () => {
    expect(isValidSessionName('my-session')).toBe(true);
  });

  it('含下划线应通过', () => {
    expect(isValidSessionName('my_session')).toBe(true);
  });

  it('纯数字应通过（\\w 包含数字）', () => {
    expect(isValidSessionName('12345')).toBe(true);
  });

  // ─── 非法输入 ──────────────────────────────────────────

  it('空字符串应拒绝', () => {
    expect(isValidSessionName('')).toBe(false);
  });

  it('含空格应拒绝', () => {
    expect(isValidSessionName('my session')).toBe(false);
  });

  it('含路径分隔符 / 应拒绝（防路径遍历）', () => {
    expect(isValidSessionName('a/b')).toBe(false);
  });

  it('含路径分隔符 \\ 应拒绝（防路径遍历）', () => {
    expect(isValidSessionName('a\\b')).toBe(false);
  });

  it('含点号应拒绝（防 ../ 遍历）', () => {
    expect(isValidSessionName('../etc')).toBe(false);
    expect(isValidSessionName('file.txt')).toBe(false);
  });

  it('含中文应通过（Unicode 字母白名单）', () => {
    expect(isValidSessionName('会话')).toBe(true);
    expect(isValidSessionName('我的会话-1')).toBe(true);
  });

  it('超过 200 字符应拒绝', () => {
    const longName = 'a'.repeat(201);
    expect(isValidSessionName(longName)).toBe(false);
  });

  it('恰好 200 字符应通过（边界）', () => {
    const name = 'a'.repeat(200);
    expect(isValidSessionName(name)).toBe(true);
  });

  it('非字符串应拒绝', () => {
    expect(isValidSessionName(null as unknown as string)).toBe(false);
    expect(isValidSessionName(undefined as unknown as string)).toBe(false);
    expect(isValidSessionName(123 as unknown as string)).toBe(false);
  });
});

// ─── isValidConfigName ───────────────────────────────────

describe('isValidConfigName', () => {
  it('合法配置名应通过', () => {
    expect(isValidConfigName('code-review')).toBe(true);
    expect(isValidConfigName('persona_default')).toBe(true);
  });

  it('含中文名称应通过（AutoConfigRefiner 产出的中文建议名）', () => {
    expect(isValidConfigName('程序员助手')).toBe(true);
    expect(isValidConfigName('偏好-TypeScript风格')).toBe(true);
    expect(isValidConfigName('TypeScript偏好')).toBe(true);
    // 含点号仍应拒绝（防路径遍历）
    expect(isValidConfigName('偏好 TypeScript.md')).toBe(false);
  });

  it('含路径分隔符应拒绝（防规则文件路径遍历）', () => {
    expect(isValidConfigName('../../etc/passwd')).toBe(false);
    expect(isValidConfigName('a/b')).toBe(false);
  });

  it('含点号应拒绝（防 .memora/rules/../ 遍历）', () => {
    expect(isValidConfigName('rule.md')).toBe(false);
    expect(isValidConfigName('.hidden')).toBe(false);
  });

  it('空字符串应拒绝', () => {
    expect(isValidConfigName('')).toBe(false);
  });

  it('超过 200 字符应拒绝', () => {
    expect(isValidConfigName('a'.repeat(201))).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isValidConfigName(null as unknown as string)).toBe(false);
  });
});

// ─── isValidContent ──────────────────────────────────────

describe('isValidContent', () => {
  it('短内容应通过', () => {
    expect(isValidContent('hello world')).toBe(true);
  });

  it('空字符串应拒绝（!content 为 true）', () => {
    expect(isValidContent('')).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isValidContent(null as unknown as string)).toBe(false);
    expect(isValidContent(undefined as unknown as string)).toBe(false);
    expect(isValidContent(123 as unknown as string)).toBe(false);
  });

  it('默认 maxLength=10MB 应通过 1MB 内容', () => {
    const content = 'a'.repeat(1024 * 1024);
    expect(isValidContent(content)).toBe(true);
  });

  it('默认 maxLength=10MB 应拒绝 11MB 内容', () => {
    const content = 'a'.repeat(11 * 1024 * 1024);
    expect(isValidContent(content)).toBe(false);
  });

  it('自定义 maxLength 应按自定义值校验', () => {
    expect(isValidContent('hello', 10)).toBe(true);
    expect(isValidContent('hello world', 10)).toBe(false);
  });

  it('内容长度恰好等于 maxLength 应通过（边界，<=）', () => {
    expect(isValidContent('hello', 5)).toBe(true);
  });
});

// ─── isValidId（FOUNDATION-SEAL Phase 3） ────────────────

describe('isValidId', () => {
  // ─── 合法输入 ──────────────────────────────────────────

  it('普通字符串应通过', () => {
    expect(isValidId('memory:用户偏好')).toBe(true);
  });

  it('纯字母 ID 应通过', () => {
    expect(isValidId('abc')).toBe(true);
  });

  it('含特殊字符的 ID 应通过（source 开放字符串，不限制字符集）', () => {
    expect(isValidId('memory:hello world!@#')).toBe(true);
  });

  it('长度恰好 500 的 ID 应通过（边界，<=）', () => {
    expect(isValidId('a'.repeat(500))).toBe(true);
  });

  // ─── 非法输入 ──────────────────────────────────────────

  it('空字符串应拒绝', () => {
    expect(isValidId('')).toBe(false);
  });

  it('非字符串（number）应拒绝', () => {
    expect(isValidId(123 as unknown as string)).toBe(false);
  });

  it('非字符串（null）应拒绝', () => {
    expect(isValidId(null as unknown as string)).toBe(false);
  });

  it('非字符串（undefined）应拒绝', () => {
    expect(isValidId(undefined as unknown as string)).toBe(false);
  });

  it('超长 ID（501 字符）应拒绝', () => {
    expect(isValidId('a'.repeat(501))).toBe(false);
  });
});

// ─── isValidSearchQuery（FOUNDATION-SEAL Phase 3） ───────

describe('isValidSearchQuery', () => {
  // ─── 合法输入 ──────────────────────────────────────────

  it('普通关键词应通过', () => {
    expect(isValidSearchQuery('用户偏好')).toBe(true);
  });

  it('空字符串应通过（触发全量召回场景）', () => {
    expect(isValidSearchQuery('')).toBe(true);
  });

  it('含特殊字符的关键词应通过', () => {
    expect(isValidSearchQuery('hello world!@#')).toBe(true);
  });

  it('长度恰好 1000 的关键词应通过（边界，<=）', () => {
    expect(isValidSearchQuery('a'.repeat(1000))).toBe(true);
  });

  // ─── 非法输入 ──────────────────────────────────────────

  it('非字符串（number）应拒绝', () => {
    expect(isValidSearchQuery(123 as unknown as string)).toBe(false);
  });

  it('非字符串（null）应拒绝', () => {
    expect(isValidSearchQuery(null as unknown as string)).toBe(false);
  });

  it('非字符串（undefined）应拒绝', () => {
    expect(isValidSearchQuery(undefined as unknown as string)).toBe(false);
  });

  it('超长关键词（1001 字符）应拒绝', () => {
    expect(isValidSearchQuery('a'.repeat(1001))).toBe(false);
  });
});

// ─── isValidPersonaName（FOUNDATION-SEAL Phase 3 轮2） ───

describe('isValidPersonaName', () => {
  // ─── 合法输入 ──────────────────────────────────────────

  it('纯字母名称应通过', () => {
    expect(isValidPersonaName('coder')).toBe(true);
  });

  it('字母+数字组合应通过', () => {
    expect(isValidPersonaName('writer2')).toBe(true);
  });

  it('含连字符应通过', () => {
    expect(isValidPersonaName('code-reviewer')).toBe(true);
  });

  it('含下划线应通过', () => {
    expect(isValidPersonaName('code_reviewer')).toBe(true);
  });

  it('含点应通过', () => {
    expect(isValidPersonaName('persona.v2')).toBe(true);
  });

  it('长度恰好 100 应通过（边界，<=）', () => {
    expect(isValidPersonaName('a'.repeat(100))).toBe(true);
  });

  // ─── 非法输入 ──────────────────────────────────────────

  it('空字符串应拒绝', () => {
    expect(isValidPersonaName('')).toBe(false);
  });

  it('非字符串（number）应拒绝', () => {
    expect(isValidPersonaName(123 as unknown as string)).toBe(false);
  });

  it('非字符串（null）应拒绝', () => {
    expect(isValidPersonaName(null as unknown as string)).toBe(false);
  });

  it('超长名称（101 字符）应拒绝', () => {
    expect(isValidPersonaName('a'.repeat(101))).toBe(false);
  });

  it('含空格应拒绝', () => {
    expect(isValidPersonaName('code reviewer')).toBe(false);
  });

  it('含路径分隔符 / 应拒绝（防路径遍历）', () => {
    expect(isValidPersonaName('../etc/passwd')).toBe(false);
  });

  it('含路径分隔符 \\ 应拒绝（防路径遍历）', () => {
    expect(isValidPersonaName('..\\etc\\passwd')).toBe(false);
  });

  it('含中文字符应拒绝（仅允许 ASCII）', () => {
    expect(isValidPersonaName('程序员')).toBe(false);
  });

  it('含特殊字符 @ 应拒绝', () => {
    expect(isValidPersonaName('coder@v2')).toBe(false);
  });
});

// ─── isValidFilePath（FOUNDATION-SEAL Phase 3 轮3） ─────

describe('isValidFilePath', () => {
  // ─── 合法输入 ──────────────────────────────────────────

  it('普通文件路径应通过', () => {
    expect(isValidFilePath('/home/user/project/file.txt')).toBe(true);
  });

  it('Windows 绝对路径应通过', () => {
    expect(isValidFilePath('C:\\Users\\test\\file.ts')).toBe(true);
  });

  it('相对路径应通过', () => {
    expect(isValidFilePath('./src/index.ts')).toBe(true);
  });

  it('含中文路径应通过（不限制字符集）', () => {
    expect(isValidFilePath('/home/用户/文档/笔记.md')).toBe(true);
  });

  it('含空格路径应通过', () => {
    expect(isValidFilePath('/home/user/my project/file.ts')).toBe(true);
  });

  it('长度恰好 1000 应通过（边界，<=）', () => {
    expect(isValidFilePath('a'.repeat(1000))).toBe(true);
  });

  // ─── 非法输入 ──────────────────────────────────────────

  it('空字符串应拒绝', () => {
    expect(isValidFilePath('')).toBe(false);
  });

  it('非字符串（number）应拒绝', () => {
    expect(isValidFilePath(123 as unknown as string)).toBe(false);
  });

  it('非字符串（null）应拒绝', () => {
    expect(isValidFilePath(null as unknown as string)).toBe(false);
  });

  it('非字符串（undefined）应拒绝', () => {
    expect(isValidFilePath(undefined as unknown as string)).toBe(false);
  });

  it('超长路径（1001 字符）应拒绝', () => {
    expect(isValidFilePath('a'.repeat(1001))).toBe(false);
  });
});

// ─── isPathAllowed ───────────────────────────────────────

describe('isPathAllowed', () => {
  // ─── 合法路径 ──────────────────────────────────────────

  it('白名单目录内的文件应通过', () => {
    const allowedDirs = ['/home/user/project'];
    expect(isPathAllowed('/home/user/project/file.txt', allowedDirs)).toBe(true);
  });

  it('白名单目录子目录内的文件应通过', () => {
    const allowedDirs = ['/home/user/project'];
    expect(isPathAllowed('/home/user/project/src/index.ts', allowedDirs)).toBe(true);
  });

  it('多个白名单目录，命中任一应通过', () => {
    const allowedDirs = ['/home/user/a', '/home/user/b'];
    expect(isPathAllowed('/home/user/b/file.txt', allowedDirs)).toBe(true);
  });

  // ─── 路径遍历攻击防护 ──────────────────────────────────

  it('含 ../ 的路径应被解析后拒绝（防路径遍历）', () => {
    const allowedDirs = ['/home/user/project'];
    // /home/user/project/../secret 解析为 /home/user/secret，不在白名单内
    expect(isPathAllowed('/home/user/project/../secret', allowedDirs)).toBe(false);
  });

  it('含 ./ 的路径应被解析后校验', () => {
    const allowedDirs = ['/home/user/project'];
    // /home/user/project/./file 解析为 /home/user/project/file，在白名单内
    expect(isPathAllowed('/home/user/project/./file.txt', allowedDirs)).toBe(true);
  });

  it('白名单目录外的文件应拒绝', () => {
    const allowedDirs = ['/home/user/project'];
    expect(isPathAllowed('/etc/passwd', allowedDirs)).toBe(false);
    expect(isPathAllowed('/home/user/other/file.txt', allowedDirs)).toBe(false);
  });

  it('前缀匹配绕过防护：/home/user/pro 不应通过（防 pro 匹配 project）', () => {
    // path.relative('/home/user/pro', '/home/user/project/file')
    // 返回 '../project/file'，以 .. 开头，应拒绝
    const allowedDirs = ['/home/user/pro'];
    expect(isPathAllowed('/home/user/project/file.txt', allowedDirs)).toBe(false);
  });

  // ─── 边界与异常 ────────────────────────────────────────

  it('空字符串应拒绝', () => {
    expect(isPathAllowed('', ['/home'])).toBe(false);
  });

  it('非字符串应拒绝', () => {
    expect(isPathAllowed(null as unknown as string, ['/home'])).toBe(false);
  });

  it('空白名单应拒绝所有路径', () => {
    expect(isPathAllowed('/home/user/file.txt', [])).toBe(false);
  });

  it('相对路径应被解析为绝对路径后校验', () => {
    // 相对路径基于 cwd 解析，测试时需用 process.cwd() 验证
    const cwd = process.cwd();
    const allowedDirs = [cwd];
    // 使用 cwd 下的文件
    expect(isPathAllowed('./package.json', allowedDirs)).toBe(true);
  });
});
