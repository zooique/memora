import { describe, it, expect } from 'vitest';
import { relativeUnderPrimaryRoot, resolveUnderPrimaryRoot } from '../refPath.js';

// 引用路径的「根归属」唯一判据：必须以**首根**为基准，越出即 fail-closed（undefined）。
// 本套件锁定 addToChat（生成侧）与 openRefInEditor（消费侧）与内核 read_file cwd 的同源
// 语义——防止将来有人改回 asRelativePath（它相对「所在根」，多根工作区下会在第二根产出
// 「chip 正常、模型读不到」的撒谎指针），或消费侧另写一套字符串守卫与生成侧漂移。
describe('引用路径根归属（相对首根；越出即 undefined）', () => {
  it('首根内的文件 → 相对路径（POSIX 分隔）', () => {
    expect(relativeUnderPrimaryRoot('/ws', '/ws/sub/x.md')).toBe('sub/x.md');
  });

  it('首根内的深层路径 → 原样相对', () => {
    expect(relativeUnderPrimaryRoot('/ws', '/ws/a/b/c.md')).toBe('a/b/c.md');
  });

  it('目标即根自身 → undefined（引用根自身无意义）', () => {
    expect(relativeUnderPrimaryRoot('/ws', '/ws')).toBeUndefined();
  });

  it('越出首根（同盘旁系）→ undefined（fail-closed，拒挂撒谎指针）', () => {
    expect(relativeUnderPrimaryRoot('/ws', '/other/x.md')).toBeUndefined();
  });

  it('空根 / 空目标 → undefined（未打开工作区时不得臆造路径）', () => {
    expect(relativeUnderPrimaryRoot('', '/ws/x.md')).toBeUndefined();
    expect(relativeUnderPrimaryRoot('/ws', '')).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('Windows 跨盘 → undefined', () => {
    expect(relativeUnderPrimaryRoot('C:\\ws', 'D:\\x.md')).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('Windows 盘内 → 归一为 POSIX 分隔', () => {
    expect(relativeUnderPrimaryRoot('C:\\ws', 'C:\\ws\\sub\\x.md')).toBe('sub/x.md');
  });
});

// 消费侧反函数（openRefInEditor 用）：ref.path 由 webview 回传 = 「打开任意文件」的上行通道，
// 校验收口在此与生成侧同模块——形态守卫（绝对 / `..`）+ 生成侧同一谓词复核 + 规范形往返校验。
// 断言用「再投影」而非写死平台分隔符：解析结果须落回首根且相对形与输入逐字一致。
describe('引用相对路径 → 首根绝对路径（消费侧；与生成侧同一判据）', () => {
  it('根内规范相对路径 → 解析为根下绝对路径（往返落回首根）', () => {
    const abs = resolveUnderPrimaryRoot('/ws', 'docs/x.md');
    expect(abs).toBeDefined();
    expect(relativeUnderPrimaryRoot('/ws', abs!)).toBe('docs/x.md');
  });

  it('绝对路径 → undefined（上行通道禁打开任意文件）', () => {
    expect(resolveUnderPrimaryRoot('/ws', '/etc/passwd')).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('Windows 盘符绝对路径 → undefined', () => {
    expect(resolveUnderPrimaryRoot('C:\\ws', 'C:\\Windows\\notepad.exe')).toBeUndefined();
  });

  it('含 `..` 段 → undefined（形态守卫先拦，不依赖解析结果）', () => {
    expect(resolveUnderPrimaryRoot('/ws', '../outside.md')).toBeUndefined();
    expect(resolveUnderPrimaryRoot('/ws', 'sub/../x.md')).toBeUndefined();
  });

  it('非规范形（冗余斜杠 / 尾斜杠 / 自引用点）→ undefined（生成侧唯一规范形）', () => {
    expect(resolveUnderPrimaryRoot('/ws', 'docs//x.md')).toBeUndefined();
    expect(resolveUnderPrimaryRoot('/ws', 'docs/')).toBeUndefined();
    expect(resolveUnderPrimaryRoot('/ws', './docs/x.md')).toBeUndefined();
  });

  it('空根 / 空路径 → undefined', () => {
    expect(resolveUnderPrimaryRoot('', 'x.md')).toBeUndefined();
    expect(resolveUnderPrimaryRoot('/ws', '')).toBeUndefined();
  });
});
