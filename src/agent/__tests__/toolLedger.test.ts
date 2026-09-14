/**
 * 文件覆盖度台账（工具读取防重 & 压缩协同 P0 侧）单元测试
 *
 * 覆盖：parseReadFileCoverage（脚注解析，R1"按需"信号）+ FileExposureLedger（记录/读回/失效/清空）
 *      + formatLedgerStub（分支②回显文案，非空拦）。
 */
import { describe, it, expect } from 'vitest';
import {
  FileExposureLedger,
  parseReadFileCoverage,
  formatLedgerStub,
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
  });

  it('单行覆盖用「X 行」表达', () => {
    const cov: FileCoverage = { totalLines: 50, coverStart: 3, coverEnd: 3, digest: 'd', cachedAtIteration: 1 };
    expect(formatLedgerStub(cov)).toContain('覆盖 3 行');
  });
});