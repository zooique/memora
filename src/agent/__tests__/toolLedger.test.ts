/**
 * 文件覆盖度台账（工具读取防重 & 压缩协同 P0 侧）单元测试
 *
 * 覆盖：parseReadFileCoverage（脚注解析，R1"按需"信号）+ FileExposureLedger（记录/读回/失效/清空）
 *      + formatLedgerStub（分支②回显文案，非空拦）+ shouldEchoLedgerStub（分支②判定单一真理源）。
 */
import { describe, it, expect } from 'vitest';
import {
  FileExposureLedger,
  parseReadFileCoverage,
  formatLedgerStub,
  shouldEchoLedgerStub,
  formatSegmentationFooter,
  READ_DIGEST_CHARS,
  type FileCoverage,
} from '@/agent/toolLedger.js';

describe('formatSegmentationFooter / parseReadFileCoverage（脚注格式单一真理源）', () => {
  it('生成与解析往返一致（改脚注格式必须两处同步，靠此守卫阻断静默失配）', () => {
    const footer = formatSegmentationFooter(1, 20, 200);
    // 生成侧文案（截断诚实化的续读入口在列）
    expect(footer).toContain('已显示第 1–20 行（共 200 行）');
    expect(footer).toContain('继续读用 offset=21');
    // 解析侧能把它还原成覆盖度（同源 → 不漂移）
    const parsed = parseReadFileCoverage('已读正文\n' + footer);
    expect(parsed).toEqual({ content: '已读正文', totalLines: 200, coverStart: 1, coverEnd: 20 });
  });
});

describe('parseReadFileCoverage（read_file 脚注解析）', () => {
  it('解析含分段脚注的结果 → 覆盖区间 + 已读正文（正文不含脚注）', () => {
    const result = '第1行\n第2行\n[read_file 分段] 已显示第 1–2 行（共 100 行）。继续读用 offset=3。';
    const cov = parseReadFileCoverage(result);
    expect(cov).toEqual({ content: '第1行\n第2行', totalLines: 100, coverStart: 1, coverEnd: 2 });
  });

  it('无脚注（读到末尾 / 未截断）→ undefined（不记录，非截断大文件无需摘要）', () => {
    expect(parseReadFileCoverage('完整的短小正文')).toBeUndefined();
  });

  it('offset 越界提示（无分段脚注格式）→ undefined', () => {
    expect(parseReadFileCoverage('[read_file] docs/a.md 共 50 行；offset=99 已超出文件末尾')).toBeUndefined();
  });

  it('病态单行截断（退化分支带脚注）同样可解析', () => {
    const result = '[该行超过单次读取预算，已截断] 超长行…\n[read_file 分段] 已显示第 3–3 行（共 500 行）。继续读用 offset=4。';
    const cov = parseReadFileCoverage(result);
    expect(cov).toBeDefined();
    expect(cov!.coverStart).toBe(3);
    expect(cov!.coverEnd).toBe(3);
    expect(cov!.totalLines).toBe(500);
  });
});

describe('FileExposureLedger（文件覆盖度台账）', () => {
  it('record→get 按规范化路径读回', () => {
    const ledger = new FileExposureLedger();
    const entry: FileCoverage = {
      totalLines: 100,
      coverStart: 1,
      coverEnd: 20,
      digest: '摘要',
      cachedAtIteration: 3,
    };
    ledger.record('docs/a.md', entry);
    expect(ledger.get('docs/a.md')).toBe(entry);
    expect(ledger.get('docs/b.md')).toBeUndefined();
    expect(ledger.size).toBe(1);
  });

  it('invalidate 作废旧覆盖度（文件被修改后）', () => {
    const ledger = new FileExposureLedger();
    ledger.record('docs/a.md', { totalLines: 1, coverStart: 1, coverEnd: 1, digest: 'd', cachedAtIteration: 1 });
    ledger.invalidate('docs/a.md');
    expect(ledger.get('docs/a.md')).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it('clear 清空全部（闭环结束）', () => {
    const ledger = new FileExposureLedger();
    ledger.record('a', { totalLines: 1, coverStart: 1, coverEnd: 1, digest: 'd', cachedAtIteration: 1 });
    ledger.record('b', { totalLines: 2, coverStart: 2, coverEnd: 2, digest: 'e', cachedAtIteration: 2 });
    ledger.clear();
    expect(ledger.size).toBe(0);
  });
});

describe('formatLedgerStub（分支②回显文案）', () => {
  it('含覆盖区间 + 替身摘要 + 续读指引（非空拦）', () => {
    const cov: FileCoverage = {
      totalLines: 100,
      coverStart: 1,
      coverEnd: 20,
      digest: '第1行…'.slice(0, READ_DIGEST_CHARS),
      cachedAtIteration: 5,
    };
    const stub = formatLedgerStub(cov);
    expect(stub).toContain('[ALREADY_READ]');
    expect(stub).toContain('第 1–20 行 / 共 100 行');
    expect(stub).toContain('offset=21');
    // 「不死锁」的核心保证：替身必须**自带内容**。
    // 上面三条（标记 / 区间 / offset）都守不住它——digest 被静默吞掉时三条仍全绿，
    // 而 LLM 拿到的是一份「有框架、无内容」的替身 = CTX-1 根因②死锁复现。
    expect(stub).toContain(cov.digest);
    expect(stub).toMatch(/要点：\S/);
  });

  it('单行覆盖用「X 行」表达', () => {
    const cov: FileCoverage = { totalLines: 50, coverStart: 3, coverEnd: 3, digest: 'd', cachedAtIteration: 1 };
    expect(formatLedgerStub(cov)).toContain('覆盖 3 行');
  });
});

describe('shouldEchoLedgerStub（分支②判定单一真理源）', () => {
  // 覆盖区间 1–20，总 100 行
  const cov: FileCoverage = { totalLines: 100, coverStart: 1, coverEnd: 20, digest: 'd', cachedAtIteration: 1 };

  it('区间续读完全落在覆盖内 → true（冗余重读，应回显摘要）', () => {
    expect(shouldEchoLedgerStub({ offset: 1, limit: 20 }, cov)).toBe(true);
    expect(shouldEchoLedgerStub({ offset: 5, limit: 10 }, cov)).toBe(true);
    expect(shouldEchoLedgerStub({ offset: 20, limit: 1 }, cov)).toBe(true);
  });

  it('区间续读未指 offset（默认第 1 行起）且 limit 落在覆盖内 → true', () => {
    expect(shouldEchoLedgerStub({ offset: undefined, limit: 20 }, cov)).toBe(true);
    expect(shouldEchoLedgerStub({ limit: 10 }, cov)).toBe(true);
  });

  it('区间续读触及覆盖起始之前 → false（回读前向区间，放行）', () => {
    expect(shouldEchoLedgerStub({ offset: 0, limit: 20 }, cov)).toBe(false);
  });

  it('区间续读触及覆盖结束之后 → false（前向读取新区间，放行）', () => {
    expect(shouldEchoLedgerStub({ offset: 21, limit: 20 }, cov)).toBe(false);
    expect(shouldEchoLedgerStub({ offset: 1, limit: 21 }, cov)).toBe(false);
  });

  it('无 limit 整读：只要有覆盖过正文 → true（回显摘要引导续读，避免截断后反复整读）', () => {
    expect(shouldEchoLedgerStub({ offset: 1 }, cov)).toBe(true); // coverEnd(20)>0，无论是否读尽
    expect(shouldEchoLedgerStub({ offset: 100 }, cov)).toBe(true);
    const fullCov: FileCoverage = { ...cov, coverEnd: 100 };
    expect(shouldEchoLedgerStub({ offset: 1 }, fullCov)).toBe(true);
  });

  it('从未覆盖过正文（coverEnd<=0）→ false（无摘要可回显，放行）', () => {
    const none: FileCoverage = { totalLines: 100, coverStart: 1, coverEnd: 0, digest: 'd', cachedAtIteration: 1 };
    expect(shouldEchoLedgerStub({ offset: 1, limit: 20 }, none)).toBe(false);
    expect(shouldEchoLedgerStub({ offset: 1 }, none)).toBe(false);
  });

  it('limit 变体整读：已覆盖到末尾 + 请求覆盖到末尾 → true（归一拦截，真机逃逸修复）', () => {
    // 真机场景：文件仅 200 行，已整读覆盖到末尾（coverEnd=200=totalLines）。
    // 之后 LLM 用 limit 500 / 250 / 400 反复 offset=1 重读 → 全部物理读到末尾，内容一致 → 全应拦。
    const cov: FileCoverage = {
      totalLines: 200,
      coverStart: 1,
      coverEnd: 200,
      digest: 'd',
      cachedAtIteration: 1,
    };
    expect(shouldEchoLedgerStub({ offset: 1, limit: 500 }, cov)).toBe(true);
    expect(shouldEchoLedgerStub({ offset: 1, limit: 250 }, cov)).toBe(true);
    expect(shouldEchoLedgerStub({ offset: 1, limit: 400 }, cov)).toBe(true);
    // 未指 offset 但极限覆盖到末尾 → 同样归一
    expect(shouldEchoLedgerStub({ offset: undefined, limit: 999 }, cov)).toBe(true);
  });

  it('limit 变体但尚未读到末尾 → false（合法前向续读新内容，不误拦）', () => {
    // 文件 200 行，但当前只覆盖到前 80 行；LLM 用大 limit 续读剩余 → 请求未覆盖到 totalLines，放行。
    const cov: FileCoverage = {
      totalLines: 200,
      coverStart: 1,
      coverEnd: 80,
      digest: 'd',
      cachedAtIteration: 1,
    };
    // reqEnd = 1+120-1 = 120 < 200 → 未触达末尾归一，走续读判定：120 > 80 → 放行
    expect(shouldEchoLedgerStub({ offset: 1, limit: 120 }, cov)).toBe(false);
    // 完全落在已覆盖内 → 拦（保持原语义不受影响）
    expect(shouldEchoLedgerStub({ offset: 1, limit: 80 }, cov)).toBe(true);
  });

  it('边界A · totalLines 为真实总行数（分段脚注源）：coverEnd 未达末尾 + 越界 limit 续读 → 放行', () => {
    // 大文件 1000 行，分段读到前 100 行（coverEnd=100）。totalLines=1000 是**文件真实总行数**（脚注源），
    // 与整读小文件场景的「totalLines=实际读行数」异构——必须保证新判据在此不误把 coverEnd 当 total。
    const cov: FileCoverage = {
      totalLines: 1000,
      coverStart: 1,
      coverEnd: 100,
      digest: 'd',
      cachedAtIteration: 1,
    };
    // reqEnd = 950+100-1 = 1049 ≥ 1000 → 覆盖到末尾归一，但 coverEnd(100) ≥ total(1000)? 否 → 放行（续读尾部真内容）
    expect(shouldEchoLedgerStub({ offset: 950, limit: 100 }, cov)).toBe(false);
    // 越界大 limit：offset=1(实际从 1 起), limit=3000 → reqEnd=3000 ≥ 1000，coverEnd 100 < 1000 → 放行
    expect(shouldEchoLedgerStub({ offset: 1, limit: 3000 }, cov)).toBe(false);
    // 对照：完全落在已覆盖内的小段仍拦（旧语义不受损）
    expect(shouldEchoLedgerStub({ offset: 1, limit: 100 }, cov)).toBe(true);
  });

  it('边界B · 已整读覆盖到末尾后回读中段 → 拦（完整落已覆盖区间，落既有区间判据）', () => {
    // 文件 1000 行，已整读 coverEnd=1000=total。LLM 因对**中段某行 token** 有精确需求回读 offset=500 limit=100。
    // reqEnd=599 < 1000 → 不触发新归一判据，走既有「区间完整落在覆盖内」判据 → 拦 + 替身回显（非死锁）。
    const cov: FileCoverage = {
      totalLines: 1000,
      coverStart: 1,
      coverEnd: 1000,
      digest: 'd',
      cachedAtIteration: 1,
    };
    expect(shouldEchoLedgerStub({ offset: 500, limit: 100 }, cov)).toBe(true);
    // 未指 offset（默认第 1 行起）的整段也在覆盖内 → 拦
    expect(shouldEchoLedgerStub({ offset: undefined, limit: 500 }, cov)).toBe(true);
  });
});