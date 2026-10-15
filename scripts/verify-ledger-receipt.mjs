#!/usr/bin/env node
/**
 * 台账销项同步校验 —— 「代码落地」与「台账销项」是否同批
 *
 * 为什么存在（缺口 · 2026-10-15 实证）：
 *   TERM-FDBK-1 的 `--changed` 增量模式随 `2fbc6743` 落地（feat 提交，信息里带着条目 ID），
 *   但同批两笔 docs 提交都没碰台账 → `tasks/待完成任务.md` 该条目仍挂「⏳ 待排期」。
 *   **代码链完成、真源链断裂**，而既有门禁对此**零覆盖**——tsc / lint / test / docs:links /
 *   terminology / rules:refs 都只认代码与文档事实，不认「台账是否与提交同步」。
 *   「审查结论必须回写台账」此前是**纯纪律**，无闸门；本脚本把它变成可执行的软门禁。
 *
 * 判据（窄口 —— 只拦高发形态，不做通用 ID 嗅探）：
 *   ① **只查实现性提交**（feat / fix / refactor / perf / revert）。docs 提交一般就是台账
 *      提交本身，纳入只会造噪音（且会因提交顺序产生假红）。
 *   ② **ID 词表来自台账条目本身**（`- **ID** —` 形态），**不用通用大写正则**——
 *      否则 `UTF-8` / `ES2020` 之类会成片假红，噪音门禁必然腐烂（同「裸章节锚」先分诊后升门的纪律）。
 *   ③ 命中条件 = 提交信息出现某 ID，**且本区间内 `tasks/` 的差异不含该 ID** → 告警。
 *      「台账动过该行」以 diff 文本含 ID 为准：销项是改行必然含 ID，删除行同样计入。
 *
 * 为什么是告警档（required: false）而不是硬闸：
 *   存在正当反例——实现性提交顺带引用 ID、销项由同批另一笔 docs 提交完成，若那笔尚未落地
 *   （提交顺序问题）会短暂命中。**先以告警档跑，假阳性率实测可控后再升 fail 门**：
 *   改判据 = 造伤的高风险动作，须先分诊（[legacy-contract-audit-rules.md §7](../.trae/rules/generic/legacy-contract-audit-rules.md)）。
 *
 * 用法：
 *   node scripts/verify-ledger-receipt.mjs                # 默认区间 origin/main..HEAD（pre-push 语义）
 *   node scripts/verify-ledger-receipt.mjs --since=HEAD~7 # 事后复盘：扫最近 N 笔
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_REL = 'tasks/待完成任务.md';

/** 实现性提交的 type 面（与 commitlint 的 type 白名单同族，不含 docs / chore / test / style） */
const IMPLEMENTING_TYPES = ['feat', 'fix', 'refactor', 'perf', 'revert'];

/** 提交主题里的 type 前缀：`feat(scripts): xxx` / `refactor: xxx` */
const TYPE_PREFIX_RE = /^([a-z]+)(\([^)\n]*\))?!?:/;

function gitOut(args) {
  // core.quotepath=false：非 ASCII 路径否则会被加引号 + 八进制转义（同族 bug：
  // terminology-carrier-snapshot.ts 的 --changed 曾因此静默漏扫中文文件）。
  // maxBuffer：台账 diff 可达数 MB，默认 1MB 会抛 ENOBUFS —— 若不显式放大，
  // 该错误会被误判成「区间不可解析」而静默跳过（**假绿缝**，实测撞过一次）。
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function argOf(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

/**
 * 台账条目 ID 词表：`- **TERM-FDBK-1** —` → TERM-FDBK-1；`**D8-文件快照回滚**` → D8（中文不进 ID）。
 *
 * ⚠️ **短 ID 必须过滤**（实测撞出来的噪音源，不是预防性收紧）：台账里存在 `search` / `L3` /
 * `D2` / `T4` / `Step` 这类 2-4 字符条目，它们在提交信息里成片命中普通词（`search` 命中任何
 * 带 search 的提交、`Step` 命中「Step 2」这类散文）→ 单次复盘刷出 **206 条**，全是噪音。
 * 噪音门禁必然被人忽略，**烂掉比没有更糟**。
 * 取舍：**宁漏报不滥报**——告警档漏掉一个短 ID 条目，代价远小于每天看 200 条假红。
 * 判据：含 `-` 且长度 ≥ 4（`TERM-FDBK-1` / `CHKPT-2` / `HOST-S3-1` / `TS-13` 全留下，
 * `search` / `L3` / `D2` / `T4` / `Step` 全滤掉）。
 */
function collectLedgerIds(text) {
  const ids = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^- \*\*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/.exec(line);
    if (m && m[1].includes('-') && m[1].length >= 4) ids.add(m[1]);
  }
  return [...ids];
}

/** `--since` 归一化：只给起点（`HEAD~7`）时自动补 `..HEAD`，否则 git 会当成「该点及之前全部历史」 */
function normalizeRange(since) {
  return since.includes('..') ? since : `${since}..HEAD`;
}

/** ID 是否以「完整词」形态出现在文本中（防 `D8` 命中 `AD8`、`TERM-FDBK-1` 命中 `TERM-FDBK-10`） */
function containsId(text, id) {
  const re = new RegExp(
    `(?<![A-Za-z0-9])${id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![A-Za-z0-9-])`,
  );
  return re.test(text);
}

function main() {
  const ledgerPath = join(ROOT, LEDGER_REL);
  if (!existsSync(ledgerPath)) {
    console.error(`❌ [ledger-receipt] 台账缺失：${LEDGER_REL}`);
    process.exit(1);
  }
  const ledgerIds = collectLedgerIds(readFileSync(ledgerPath, 'utf8'));
  if (ledgerIds.length === 0) {
    console.error(
      '❌ [ledger-receipt] 台账条目 ID 解析为 0 —— 条目格式可能已变，判据失明比假绿更危险',
    );
    process.exit(1);
  }

  const since = argOf('since');
  const range = since ? normalizeRange(since) : 'origin/main..HEAD';
  let logText;
  let diffText;
  try {
    // \x1f 分隔 hash 与正文，\x1e 分隔记录——正文含换行，不能用行切分
    logText = gitOut(['log', range, '--format=%H%x1f%B%x1e']);
    // --unified=0：只要变更行（ID 必在变更行里），省掉十余倍上下文体积
    diffText = gitOut(['diff', range, '--unified=0', '--', 'tasks/']);
  } catch (err) {
    // 两类失败**不可混为一谈**（混了就是假绿）：
    //   ① git 正常退出但非零 status（128）= 区间/参数问题（无 origin/main、--since 写错）→ 出声跳过；
    //   ② spawn 层故障（无 status：ENOBUFS / git 不在 PATH）→ **必须报错**，否则脚本静默失效。
    if (typeof err.status === 'number') {
      console.log(`⚠️  [ledger-receipt] 区间 ${range} 无法解析，跳过（git exit=${err.status}）`);
      process.exit(0);
    }
    console.error(`❌ [ledger-receipt] git 调用失败（非区间问题，禁止静默跳过）：${err.message}`);
    process.exit(1);
  }

  const commits = logText
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, ...bodyParts] = rec.split('\x1f');
      return { hash, message: bodyParts.join('\x1f') };
    });

  if (commits.length === 0) {
    console.log(`✅ [ledger-receipt] 区间 ${range} 无提交，跳过`);
    process.exit(0);
  }

  const hits = [];
  for (const c of commits) {
    const subject = c.message.split('\n').find(Boolean) ?? '';
    const typeMatch = TYPE_PREFIX_RE.exec(subject);
    if (!typeMatch || !IMPLEMENTING_TYPES.includes(typeMatch[1])) continue;
    for (const id of ledgerIds) {
      if (containsId(c.message, id) && !containsId(diffText, id)) {
        hits.push({ id, hash: c.hash.slice(0, 8), subject: subject.slice(0, 72) });
      }
    }
  }

  if (hits.length > 0) {
    console.log(
      `⚠️  [ledger-receipt] ${hits.length} 处「实现性提交携带台账 ID，但区间内台账无对应变更」：`,
    );
    // 输出封顶：成片命中时刷屏只会让人直接忽略，截断 + 提示总数才有处置价值
    for (const h of hits.slice(0, 20)) console.log(`   ${h.id}  ← ${h.hash} ${h.subject}`);
    if (hits.length > 20)
      console.log(`   … 另有 ${hits.length - 20} 条（先处理前 20 条，噪音成片说明判据该收紧）`);
    console.log(
      '\n   处置：销项改 tasks/待完成任务.md 对应条目（标 ✅ + 收据，销项留主台账、发版才迁 archive）；' +
        '\n   或改提交信息去掉该 ID 引用（ID 若只是顺便提及，不是本笔落地项）。' +
        `\n   区间=${range} · 扫了 ${commits.length} 个提交 / ${ledgerIds.length} 个台账 ID\n`,
    );
    process.exit(1);
  }

  console.log(
    `✅ [ledger-receipt] 区间内无「实现性提交携带 ID 而台账未动」（扫了 ${commits.length} 个提交 / ${ledgerIds.length} 个台账 ID）`,
  );
}

main();
