/**
 * 文件覆盖度台账（工具读取防重 & 压缩协同）单元测试
 *
 * 覆盖：parseReadFileCoverage（脚注解析，"按需"信号）+ FileExposureLedger（记录/读回/失效/清空）
 *      + formatLedgerStub（分支②回显文案，非空拦）+ shouldEchoLedgerStub（分支②判定单一真理源，
 *      含「原文仍在上下文」前置——死路回放不变式的判定层守卫）。
 */
import { describe, it, expect } from 'vitest';
import {
  FileExposureLedger,
  parseReadFileCoverage,
  formatLedgerStub,
  formatLedgerStubRange,
  sliceCoveredLines,
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
    const result =
      '第1行\n第2行\n[read_file 分段] 已显示第 1–2 行（共 100 行）。继续读用 offset=3。';
    const cov = parseReadFileCoverage(result);
    expect(cov).toEqual({ content: '第1行\n第2行', totalLines: 100, coverStart: 1, coverEnd: 2 });
  });

  it('无脚注（读到末尾 / 未截断）→ undefined（不记录，非截断大文件无需摘要）', () => {
    expect(parseReadFileCoverage('完整的短小正文')).toBeUndefined();
  });

  it('offset 越界提示（无分段脚注格式）→ undefined', () => {
    expect(
      parseReadFileCoverage('[read_file] docs/a.md 共 50 行；offset=99 已超出文件末尾'),
    ).toBeUndefined();
  });

  it('病态单行截断（退化分支带脚注）同样可解析', () => {
    const result =
      '[该行超过单次读取预算，已截断] 超长行…\n[read_file 分段] 已显示第 3–3 行（共 500 行）。继续读用 offset=4。';
    const cov = parseReadFileCoverage(result);
    expect(cov).toBeDefined();
    expect(cov!.coverStart).toBe(3);
    expect(cov!.coverEnd).toBe(3);
    expect(cov!.totalLines).toBe(500);
  });
});

describe('FileExposureLedger（文件覆盖度台账）', () => {
  it('record→get 按规范化路径读回（含在上下文判定三件套：lastToolCallId + fingerprint 原样带出）', () => {
    const ledger = new FileExposureLedger();
    const entry: FileCoverage = {
      totalLines: 100,
      coverStart: 1,
      coverEnd: 20,
      digest: '摘要',
      cachedAtIteration: 3,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    ledger.record('docs/a.md', entry);
    expect(ledger.get('docs/a.md')).toBe(entry);
    expect(ledger.get('docs/b.md')).toBeUndefined();
    expect(ledger.size).toBe(1);
  });

  it('invalidate 作废旧覆盖度（文件被修改后）', () => {
    const ledger = new FileExposureLedger();
    ledger.record('docs/a.md', {
      totalLines: 1,
      coverStart: 1,
      coverEnd: 1,
      digest: 'd',
      cachedAtIteration: 1,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    });
    ledger.invalidate('docs/a.md');
    expect(ledger.get('docs/a.md')).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it('clear 清空全部（闭环结束）', () => {
    const ledger = new FileExposureLedger();
    ledger.record('a', {
      totalLines: 1,
      coverStart: 1,
      coverEnd: 1,
      digest: 'd',
      cachedAtIteration: 1,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    });
    ledger.record('b', {
      totalLines: 2,
      coverStart: 2,
      coverEnd: 2,
      digest: 'e',
      cachedAtIteration: 2,
      lastToolCallId: 'c2',
      fingerprint: 'fp-b',
    });
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
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
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
    const cov: FileCoverage = {
      totalLines: 50,
      coverStart: 3,
      coverEnd: 3,
      digest: 'd',
      cachedAtIteration: 1,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    expect(formatLedgerStub(cov)).toContain('覆盖 3 行');
  });

  it('文案不含「被压缩」状态断言，引导语用条件语气（两语境共用：压缩原位替换 / 重读回显——断言单一语境状态即撒谎）', () => {
    const cov: FileCoverage = {
      totalLines: 100,
      coverStart: 1,
      coverEnd: 100,
      digest: 'd',
      cachedAtIteration: 1,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    const stub = formatLedgerStub(cov);
    expect(stub).not.toContain('被压缩');
    // 条件语气（两语境皆真）+ 真实性守卫：禁改回断言「原文已在上文」——回显语境原文也可能已被压缩
    expect(stub).toContain('若原文仍在本次对话上文，可直接引用');
    expect(stub).not.toContain('原文已在本次对话上文');
  });
});

describe('shouldEchoLedgerStub（分支②判定单一真理源）', () => {
  // 覆盖区间 1–20，总 100 行
  const cov: FileCoverage = {
    totalLines: 100,
    coverStart: 1,
    coverEnd: 20,
    digest: 'd',
    cachedAtIteration: 1,
    lastToolCallId: 'c1',
    fingerprint: 'fp-a',
  };
  // 本组专测「原文仍在上下文（true）」前提下的区间判定；前置本身的判定另设专门用例（见组尾）
  const echo = (subj: { offset?: number; limit?: number }, c: FileCoverage) =>
    shouldEchoLedgerStub(subj, c, true);

  it('区间续读完全落在覆盖内 → true（冗余重读，应回显摘要）', () => {
    expect(echo({ offset: 1, limit: 20 }, cov)).toBe(true);
    expect(echo({ offset: 5, limit: 10 }, cov)).toBe(true);
    expect(echo({ offset: 20, limit: 1 }, cov)).toBe(true);
  });

  it('区间续读未指 offset（默认第 1 行起）且 limit 落在覆盖内 → true', () => {
    expect(echo({ offset: undefined, limit: 20 }, cov)).toBe(true);
    expect(echo({ limit: 10 }, cov)).toBe(true);
  });

  it('区间续读触及覆盖起始之前 → false（回读前向区间，放行）', () => {
    expect(echo({ offset: 0, limit: 20 }, cov)).toBe(false);
  });

  it('区间续读触及覆盖结束之后 → false（前向读取新区间，放行）', () => {
    expect(echo({ offset: 21, limit: 20 }, cov)).toBe(false);
    expect(echo({ offset: 1, limit: 21 }, cov)).toBe(false);
  });

  it('无 limit 整读：起点落在已覆盖区间内 → true（回显摘要引导续读，避免截断后反复整读）', () => {
    expect(echo({ offset: 1 }, cov)).toBe(true); // 省略 offset ≡ 第 1 行起，落在 1–20 内
    expect(echo({ offset: 20 }, cov)).toBe(true); // 起点仍在覆盖末行上（重叠 1 行）
    const fullCov: FileCoverage = { ...cov, coverEnd: 100 };
    expect(echo({ offset: 1 }, fullCov)).toBe(true);
  });

  it('无 limit 续读：起点超出已覆盖区间 → false（放行真实执行，破「照引导走仍被拦」死循环）', () => {
    // cov 覆盖 1–20；offset=21 正是 formatLedgerStub 引导的续读写法（coverEnd+1）。
    // 旧判据只看 limit 有无，把这两条一并拦死 → 大文件截断后模型按引导续读仍被拦，永远读不到第二段。
    expect(echo({ offset: 21 }, cov)).toBe(false);
    expect(echo({ offset: 100 }, cov)).toBe(false);
  });

  it('从未覆盖过正文（coverEnd<=0）→ false（无摘要可回显，放行）', () => {
    const none: FileCoverage = {
      totalLines: 100,
      coverStart: 1,
      coverEnd: 0,
      digest: 'd',
      cachedAtIteration: 1,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    expect(echo({ offset: 1, limit: 20 }, none)).toBe(false);
    expect(echo({ offset: 1 }, none)).toBe(false);
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
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    expect(echo({ offset: 1, limit: 500 }, cov)).toBe(true);
    expect(echo({ offset: 1, limit: 250 }, cov)).toBe(true);
    expect(echo({ offset: 1, limit: 400 }, cov)).toBe(true);
    // 未指 offset 但极限覆盖到末尾 → 同样归一
    expect(echo({ offset: undefined, limit: 999 }, cov)).toBe(true);
  });

  it('limit 变体但尚未读到末尾 → false（合法前向续读新内容，不误拦）', () => {
    // 文件 200 行，但当前只覆盖到前 80 行；LLM 用大 limit 续读剩余 → 请求未覆盖到 totalLines，放行。
    const cov: FileCoverage = {
      totalLines: 200,
      coverStart: 1,
      coverEnd: 80,
      digest: 'd',
      cachedAtIteration: 1,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    // reqEnd = 1+120-1 = 120 < 200 → 未触达末尾归一，走续读判定：120 > 80 → 放行
    expect(echo({ offset: 1, limit: 120 }, cov)).toBe(false);
    // 完全落在已覆盖内 → 拦（保持原语义不受影响）
    expect(echo({ offset: 1, limit: 80 }, cov)).toBe(true);
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
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    // reqEnd = 950+100-1 = 1049 ≥ 1000 → 覆盖到末尾归一，但 coverEnd(100) ≥ total(1000)? 否 → 放行（续读尾部真内容）
    expect(echo({ offset: 950, limit: 100 }, cov)).toBe(false);
    // 越界大 limit：offset=1(实际从 1 起), limit=3000 → reqEnd=3000 ≥ 1000，coverEnd 100 < 1000 → 放行
    expect(echo({ offset: 1, limit: 3000 }, cov)).toBe(false);
    // 对照：完全落在已覆盖内的小段仍拦（旧语义不受损）
    expect(echo({ offset: 1, limit: 100 }, cov)).toBe(true);
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
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    expect(echo({ offset: 500, limit: 100 }, cov)).toBe(true);
    // 未指 offset（默认第 1 行起）的整段也在覆盖内 → 拦
    expect(echo({ offset: undefined, limit: 500 }, cov)).toBe(true);
  });

  it('前置 · 原文不在上下文（stillInContext=false）→ 一律放行（死路回放不变式的判定层守卫）', () => {
    // 生产实锤（round-1791449684099）：整读→压缩→中段重读，原文已被压缩链清出，旧逻辑仍回显
    // 顶头摘要替身——模型要的中段 token 永远不在替身里 → 同参重读被同一条判据反复拦 = 死路。
    // 契约：前置不过则一切区间判定短路为放行（真读一次拿回内容，后续防重交分支①承接）。
    expect(shouldEchoLedgerStub({ offset: 1, limit: 20 }, cov, false)).toBe(false);
    expect(shouldEchoLedgerStub({ offset: 1 }, cov, false)).toBe(false);
    // 区间判定本应拦的归一场景（已覆盖到末尾 + limit 变体整读）同样被前置放行
    const fullCov: FileCoverage = { ...cov, totalLines: 200, coverEnd: 200 };
    expect(shouldEchoLedgerStub({ offset: 1, limit: 500 }, fullCov, false)).toBe(false);
    // 已覆盖到末尾后的中段回读（边界B 场景）在压缩后同样放行
    expect(shouldEchoLedgerStub({ offset: 500, limit: 100 }, fullCov, false)).toBe(false);
  });
});

describe('formatLedgerStub · 越界引导（真机 round-1791449684099 实证）', () => {
  it('已读到末尾（coverEnd >= totalLines）→ 不再给出 offset=coverEnd+1 越界示例', () => {
    // 生产实锤：89 行章纲已整读（coverEnd=89=total），旧文案仍引导 `offset=90`——越界行号，
    // 模型照着走只会拿到越界提示。文案给的每条出路必须可走通，否则即假出路。
    const cov: FileCoverage = {
      totalLines: 89,
      coverStart: 1,
      coverEnd: 89,
      digest: 'd',
      cachedAtIteration: 4,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    const stub = formatLedgerStub(cov);
    expect(stub).not.toContain('offset=90');
    expect(stub).toContain('已读到末尾');
  });

  it('未读到末尾 → 仍给 offset=coverEnd+1 续读指引（旧语义不受损）', () => {
    const cov: FileCoverage = {
      totalLines: 1000,
      coverStart: 1,
      coverEnd: 200,
      digest: 'd',
      cachedAtIteration: 2,
      lastToolCallId: 'c1',
      fingerprint: 'fp-a',
    };
    expect(formatLedgerStub(cov)).toContain('offset=201');
  });
});

describe('sliceCoveredLines（分支②回显取材：按请求区间切已读原文）', () => {
  // 已整读 1–10 行（真实总行数 10），正文逐行可辨
  const body = 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10';
  const cov: FileCoverage = {
    totalLines: 10,
    coverStart: 1,
    coverEnd: 10,
    digest: 'L1',
    cachedAtIteration: 1,
    lastToolCallId: 'c1',
    fingerprint: 'fp-a',
  };

  it('命中：按 offset/limit 切出请求区间原文（模型要哪段给哪段）', () => {
    const s = sliceCoveredLines(body, cov, { offset: 3, limit: 4 });
    expect(s).toBeDefined();
    expect(s!.startLine).toBe(3);
    expect(s!.endLine).toBe(6);
    expect(s!.text).toBe('L3\nL4\nL5\nL6');
  });

  it('命中：无 limit = 读到末尾', () => {
    const s = sliceCoveredLines(body, cov, { offset: 8 });
    expect(s!.text).toBe('L8\nL9\nL10');
    expect(s!.endLine).toBe(10);
  });

  it('未命中：请求区间越出已覆盖 → undefined（宁退化顶头替身，也不编造未读内容）', () => {
    const partial: FileCoverage = { ...cov, coverEnd: 5 };
    expect(sliceCoveredLines(body, partial, { offset: 4, limit: 5 })).toBeUndefined();
    expect(sliceCoveredLines(body, partial, { offset: 9, limit: 1 })).toBeUndefined();
  });

  it('未命中：起点早于覆盖起点 → undefined（前向未读区，交给放行真读）', () => {
    const mid: FileCoverage = { ...cov, coverStart: 6, coverEnd: 10 };
    expect(sliceCoveredLines(body, mid, { offset: 1, limit: 2 })).toBeUndefined();
  });

  it('行号平移正确：已读段非从头开始（coverStart=6）时，请求 offset=7 取的是正文第 2 行', () => {
    // 盲区守卫：coverStart=1 的场景下「start-coverStart」与「start-1」等价，平移错了也测不出来。
    // 本用例把已读段挪到中段，平移一旦写错（漏减 coverStart）取到的就是错行或直接越界。
    const tailBody = 'L6\nL7\nL8\nL9\nL10';
    const midCov: FileCoverage = {
      totalLines: 10,
      coverStart: 6,
      coverEnd: 10,
      digest: 'L6',
      cachedAtIteration: 3,
      lastToolCallId: 'c1',
      fingerprint: 'fp-b',
    };
    const s = sliceCoveredLines(tailBody, midCov, { offset: 7, limit: 2 });
    expect(s!.text).toBe('L7\nL8');
  });

  it('分段脚注正文也能切（脚注在本函数内剥除，与 parseReadFileCoverage 同源）', () => {
    const seg = 'L1\nL2\nL3' + '\n' + formatSegmentationFooter(1, 3, 10);
    const s = sliceCoveredLines(
      seg,
      { ...cov, coverStart: 1, coverEnd: 3 },
      { offset: 2, limit: 2 },
    );
    expect(s!.text).toBe('L2\nL3');
  });
});

describe('formatLedgerStubRange（分支②区间回显文案）', () => {
  const cov: FileCoverage = {
    totalLines: 10,
    coverStart: 1,
    coverEnd: 10,
    digest: 'L1',
    cachedAtIteration: 7,
    lastToolCallId: 'c1',
    fingerprint: 'fp-a',
  };
  const body = 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10';

  it('命中：回显请求区间原文 + 标注未重新读取（事实陈述，非状态断言）', () => {
    const stub = formatLedgerStubRange(cov, { offset: 4, limit: 3 }, body);
    expect(stub).toContain('[ALREADY_READ]');
    expect(stub).toContain('第 4–6 行');
    expect(stub).toContain('L4\nL5\nL6');
    expect(stub).toContain('未重新读取文件');
    // 真实性守卫：不得断言「原文已在本文」（与 formatLedgerStub 同纪律）
    expect(stub).not.toContain('原文已在本次对话上文');
  });

  it('拿不到原文（undefined）→ 退化顶头替身版，逐字同 formatLedgerStub', () => {
    expect(formatLedgerStubRange(cov, { offset: 4, limit: 3 }, undefined)).toBe(
      formatLedgerStub(cov),
    );
  });

  it('区间切不出（越出覆盖）→ 同样退化顶头替身版', () => {
    const partial: FileCoverage = { ...cov, coverEnd: 2 };
    expect(formatLedgerStubRange(partial, { offset: 8, limit: 2 }, body)).toBe(
      formatLedgerStub(partial),
    );
  });
});
