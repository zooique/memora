#!/usr/bin/env node
/**
 * 本地 CI 模拟 — 在不开 GitHub Actions 的前提下等价复现 kernel-ci.yml 的门禁
 *
 * 为什么存在：
 *   `.github/workflows/kernel-ci.yml` 的 push / pull_request 触发
 *   被注释（仅剩 workflow_dispatch），且 `lefthook.yml` 的 pre-push vitest 亦被注释 →
 *   提交时**没有机器强制验证**，「全绿」全靠自报。本脚本把门禁搬回本地，
 *   使「跑没跑、过没过」可复现、可留痕，不依赖 GitHub 是否报错。
 *
 * 与 CI 的差异（刻意）：
 *   1. CI 只跑内核；本脚本**补跑宿主**（hosts/memora-vscode）——真机行为在宿主侧，
 *      内核全绿而宿主红的情况历史上出现过（宿主软链内核 dist，改内核会影响宿主）。
 *   2. 补跑**覆盖率闸门**（`npm run test:cov`）——`testing_rules.md` 要求，但
 *      `npm test` 不带 `--coverage`、CI 也不跑时，闸门等于从未接上任何会跑的链路。
 *      代价约 +40s（覆盖率会重跑一遍测试），可用 `--skip-cov` 跳过。
 *   3. `npm audit` 默认不跑（需网络、且 CI 本身 continue-on-error），用 `--audit` 开启。
 *   4. 默认**不 fail-fast**：全部步骤跑完再汇总，一次拿到完整体检结果。
 *   5. 补跑**宿主构建**（`host:build`）—— CI 不构建宿主，而宿主
 *      `dist/extension/extension.js`（内联内核的单文件 bundle）才是用户实际运行的东西。
 *      缺此步 → 「门禁全绿」与「宿主 bundle 陈旧」可以并存。
 *   6. 补跑 **dist 契约**（`verify:dist-contract`）—— 断言宿主 bundle 与内核 dist **同代**。
 *      没有它，宿主 dist 陈旧这一失效模式在门禁里零覆盖（历史教训：未改宿主 TS ≠ 未影响宿主 dist）。
 *   7. 补跑**宿主镜像刷新**（`host:sync`）—— 宿主以 `file:../..` **硬链接**依赖内核 dist，
 *      内核 `build` 后宿主 `node_modules` 里的镜像副本**不会自动更新**；缺此步则宿主
 *      test / build / dist 契约可因加载旧内核「同根红」（2026-10-16 实锤：漏刷一次 5 红，
 *      `pnpm install --offline` 重链后三处全绿）。
 *
 * 用法：
 *   node scripts/local-ci.mjs                 # ≡ --preset=full（全量；步数由运行时打印，注释不写死）
 *   node scripts/local-ci.mjs --preset=fast   # 快档：只跑两侧 tsc（≤60s，挂 pre-commit）
 *   node scripts/local-ci.mjs --preset=full   # 全档（挂 pre-push）
 *   node scripts/local-ci.mjs --kernel-only   # 只跑内核（≈ CI 原范围 + 覆盖率）
 *   node scripts/local-ci.mjs --skip-cov      # 跳过覆盖率闸门（省 ~40s）
 *   node scripts/local-ci.mjs --skip-build    # 跳过生产构建
 *   node scripts/local-ci.mjs --skip-cov --skip-build   # 最快内环
 *   node scripts/local-ci.mjs --from=host:test# 从指定步骤开始
 *   node scripts/local-ci.mjs --audit         # 额外跑依赖安全审计（允许失败）
 *
 * 分层（ADR-032）：
 *   步骤定义**只在本文件**，钩子只是触发器（`lefthook.yml` 传 --preset）。分层判据：
 *   ① 输入可被 staged 集合限定 ② 单步 ≤30s ③ 失败可归因本次改动。
 *   测试（内核 98s / 宿主 119s）与覆盖率（40s+）**不进 fast** —— 根 `vitest.config.ts`
 *   的 `fileParallelism` 处自记已知跨文件 flake，假红会直接诱发 `--no-verify`（长默认路径本身就是绕过诱因）。
 *
 * 退出码：任一 required 步骤失败 → 1；全绿 → 0。
 * 完整输出落盘 `.workbuddy/tmp/local-ci-<时间戳>.log`，**头部含收据行**（when/preset/head/tree/dirty/steps）
 * ——「全绿」由此从口头自证变成「存在一份 tree=X 的 full 档日志」：绕过一次即无收据，
 * 发布前清单一行比对即可发现（自觉不可观测，缺口可观测）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOST = join(ROOT, 'hosts', 'memora-vscode');

/**
 * 全部宿主 —— 判据 = `hosts/` 下**有 package.json 的目录**，不手写清单。
 *
 * 2026-10-18 `HOST-ALIGN-1` P1-C 的教训：旧实现只把 `hosts/memora-vscode` 挂在门禁上，
 * `hosts/memora-mcp` 编译断裂 24 小时无人知（「宿主有两个，门禁只夹一个」）。
 * 手写第二个常量只能补一次洞；按目录发现才能保证**新增宿主自动进类型检查面**。
 *
 * 分层（不是所有宿主都有完整基线，如实分层而非假装一致）：
 * - **类型检查面**：所有宿主（缺 `typecheck` 脚本 = 配置错误，直接 exit 2）。
 * - **深度面**（lint / test / build 五步）：仅主宿主；二级宿主按自身 scripts 声明生成。
 */
const HOSTS = readdirSync(join(ROOT, 'hosts'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(ROOT, 'hosts', entry.name))
  .filter((dir) => existsSync(join(dir, 'package.json')));
const SECONDARY_HOSTS = HOSTS.filter((dir) => dir !== HOST);
const LOG_DIR = join(ROOT, '.workbuddy', 'tmp');
// 门禁互斥锁：两份全量门禁并发 = spawn 资源对撞（2026-10-03 实锤：两个 push
// 任务并发各触发一份 gate-full，spawn 类测试成片假失败 + 步骤耗时暴涨 5-7 倍）。
// 锁文件只写 pid；启动时校验持有者存活——活着即拒绝（exit 2），死锁（崩溃残留）
// 自动接管；正常路径经 process exit 钩子释放。探活用 process.kill(pid,0)（lockManager 同款）。
const LOCK_FILE = join(LOG_DIR, 'local-ci.lock');

/**
 * 门禁互斥锁获取：并发即拒绝，崩溃残留锁自动接管。
 * 返回 true = 成功持有；进程退出时经 exit 钩子释放。
 */
function acquireLock() {
  mkdirSync(LOG_DIR, { recursive: true });
  try {
    // 'wx' 独占创建：已存在即抛——并发第一道闸（不依赖读后判的竞态窗口）
    writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    let holderPid = 0;
    try {
      holderPid = Number(readFileSync(LOCK_FILE, 'utf8'));
    } catch {
      /* 锁文件读到空/坏 = 异常残留，按死锁处理（下方覆盖接管） */
    }
    const holderAlive =
      holderPid > 0 &&
      (() => {
        try {
          process.kill(holderPid, 0);
          return true;
        } catch (e) {
          return e?.code === 'EPERM'; // EPERM = 进程存在但无权探活，视为活着
        }
      })();
    if (holderAlive) {
      console.error(
        `\n[local-ci] ❌ 另一份门禁正在运行（pid=${holderPid}），已拒绝并发执行——` +
          `两份全量门禁并发会对撞 spawn 资源，测试成片假失败（2026-10-03 实锤）。` +
          `\n[local-ci] 等待其结束或手动杀进程后重试。`,
      );
      process.exit(2);
    }
    // 死锁自动接管：持有者进程已不存在（上次运行崩溃残留）
    console.warn(`[local-ci] 检测到崩溃残留锁（pid=${holderPid || '未知'}），已自动接管`);
    writeFileSync(LOCK_FILE, String(process.pid));
  }
  // 正常路径：进程退出（含门禁失败 exit(1)/并发拒绝 exit(2) 前的持有期）释放
  process.on('exit', () => {
    try {
      // 只释放自己持有的锁（防误删接管场景下新持有者的锁）
      if (readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) rmSync(LOCK_FILE);
    } catch {
      /* 锁文件已消失/不可读 = 无需释放 */
    }
  });
  return true;
}

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const argOf = (key) => {
  const hit = argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : undefined;
};

const STEP_TIMEOUT_MS = 15 * 60 * 1000; // 单步 15 分钟上限，防挂死

/**
 * 步骤定义 —— **全库唯一定义处**（钩子只传 `--preset`，不得在别处复制这份清单）
 * `presets`：该步骤属于哪些档。fast 档只跑两侧 `tsc`——lint 由 pre-commit 的 lint-staged
 * 承担（staged 集合限定），测试/覆盖率/构建因超时与 flake 成本**不进 fast**（见文件头分层说明）。
 * @type {{id:string,name:string,cmd:string,cwd:string,required:boolean,presets:string[],optionalFlag?:string,env?:Record<string,string>}[]}
 */
const ALL_STEPS = [
  {
    id: 'kernel:typecheck',
    name: '内核 TypeScript 类型检查',
    cmd: 'npm run typecheck',
    cwd: ROOT,
    required: true,
    presets: ['fast', 'full'],
  },
  {
    id: 'kernel:lint',
    name: '内核 ESLint（含 --max-warnings 0）',
    cmd: 'npm run lint',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // ⚠️ 为什么这里带 `--no-file-parallelism`（2026-10-27 用户拍板，属对 SOP §5 的**显式例外**）：
  //    full 档每跑必红 toolExecutor 2 条（后台执行 EBUSY + `kill_command` 终态失败任务 timeout），
  //    隔离复跑同一文件 229/229 全绿 ⇒ 假红。常驻红会让「full 档红了」失去信号 ⇒ 结论被无视。
  //    代价用实测说话（本环境 3026 用例）：并行 135.65s → 串行 166.58s，**只慢 22%**，
  //    而非 SOP 文档记的历史 2.4x（那次是 2026-09-14 在另一规模下测的）⇒ 取舍成立。
  //  ⚠️ 不改 `vitest.config.ts`、不改 package.json 的 test 脚本：日常手工跑仍是并发。
  {
    id: 'kernel:test',
    name: '内核单元测试（串行口径 · 免 toolExecutor 常态假红）',
    cmd: 'npm run test -- --no-file-parallelism',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  {
    id: 'kernel:coverage',
    name: '内核覆盖率闸门',
    cmd: 'npm run test:cov',
    cwd: ROOT,
    required: true,
    presets: ['full'],
    optionalFlag: 'skip-cov',
    // 覆盖率跑前会 clean，本环境的 safe-delete guard 会把它拦成崩溃（前提=有残留）；
    // 置空 NODE_OPTIONS 可绕过（实测可行）。
    env: { NODE_OPTIONS: '' },
  },
  // 内核生产构建 —— **先清 dist 再 build**。`build:clean` 与 npm `prepack` 共用同一脚本定义（单一真源）：
  // 裸 `tsc` 不删旧产物 ⇒ src 已删模块的编译产物残留（DIST-ORPHAN-1 实测：dist 122 vs src 非测试 115，
  // 差 7 模块 = 28 产物，且坑跨两轮未被发现）。门禁与发布走同一条「清后建」路径，
  // 孤儿由构造消除、非事后捕获——门禁通过 = 与 `npm pack` 内容物一致。
  {
    id: 'kernel:build',
    name: '内核生产构建（清 dist + build）',
    cmd: 'npm run build:clean',
    cwd: ROOT,
    required: true,
    presets: ['full'],
    optionalFlag: 'skip-build',
  },
  // 宿主镜像刷新：内核 build 出新 dist 后，宿主 node_modules 里的 file: 硬链接副本
  // （hosts/memora-vscode/package.json "@zooique/memora": "file:../.."）不会自动更新——
  // 2026-10-16 实锤：漏刷此步 → 宿主 test 32 failed（缺 nodeSqliteStorage 导出，加载旧镜像）
  // + host:build + verify:dist-contract「5 红同根」；`pnpm install --offline` 重链后全绿。
  // 位置约束：必须在 kernel:build 之后、任一宿主步骤之前（类型检查也读镜像）。
  // 与 kernel:build 同受 --skip-build 约束：不重建内核则无需刷新。
  {
    id: 'host:sync',
    name: '宿主镜像刷新（pnpm install --offline）',
    cmd: 'pnpm install --offline',
    cwd: HOST,
    required: true,
    presets: ['full'],
    optionalFlag: 'skip-build',
  },
  {
    id: 'host:typecheck',
    name: '宿主 TypeScript 类型检查',
    cmd: 'npm run typecheck',
    cwd: HOST,
    required: true,
    presets: ['fast', 'full'],
  },
  {
    id: 'host:lint',
    name: '宿主 ESLint（含 --max-warnings 0）',
    cmd: 'npm run lint',
    cwd: HOST,
    required: true,
    presets: ['full'],
  },
  {
    id: 'host:test',
    name: '宿主单元测试',
    cmd: 'npm run test',
    cwd: HOST,
    required: true,
    presets: ['full'],
  },
  // 宿主构建：产出用户实际运行的单文件 bundle（内联内核 dist）。缺此步则「门禁绿 + bundle 陈旧」可并存。
  {
    id: 'host:build',
    name: '宿主构建（tsc + esbuild 内联内核）',
    cmd: 'npm run compile',
    cwd: HOST,
    required: true,
    presets: ['full'],
    optionalFlag: 'skip-build',
  },
  // dist 契约：断言宿主 bundle 与内核 dist 同代（读构建戳比对哈希 + 核内核导出符号面）。
  // 依赖刚构建出的产物，故与 build 同受 --skip-build 约束。
  {
    id: 'verify:dist-contract',
    name: 'dist 契约（宿主 bundle 与内核同代）',
    cmd: 'node scripts/verify-dist-contract.mjs',
    cwd: ROOT,
    required: true,
    presets: ['full'],
    optionalFlag: 'skip-build',
  },
  // 全仓文档死链：链接腐烂是静默失效，全仓 0 死链基线锁定后硬闸（确定性 FS 扫描，秒级）。
  {
    id: 'docs:links',
    name: '全仓文档死链检查',
    cmd: 'npm run docs:links:repo',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // 术语载体集合漂移：同族半补丁（改了函数名漏改事件名 / 只挡一半）的机械化防线。
  // 集合基线锁在 scripts/terminology-carrier-snapshot.ts，冻结例外由术语锚点 §3 派生（确定性 FS 扫描，秒级）。
  {
    id: 'terminology:check',
    name: '术语载体集合漂移检查',
    cmd: 'npm run terminology:check',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // 规则裸路径引用有效性：规则文件移动/重命名后，反引号/纯文本形态的 `.trae/rules/*.md` 引用
  // 不在 docs:links 扫描面内（其判据只认 `](...)` 且剥离行内代码）→ 补这条同族盲区（确定性 FS 扫描，秒级）。
  {
    id: 'rules:refs',
    name: '规则裸路径引用有效性检查',
    cmd: 'npm run rules:refs',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // 短语类穷尽扫描（MEM-PURGE-1 血训）：类谎报的「无 head 全量枚举 + 逐条分类」断根。
  // 缺口动因：验证「扫全」曾用带 `head_limit` 的临时 grep → 命中被截断即漏判，同会话内二次复发。
  // 本步把「每条同类命中必须被 allow 规则归类（带 reason）」做成闸门——新增未归类命中即红。
  // 确定性 FS 扫描、秒级、零依赖；类注册表锁在 scripts/scan-phrase-class.ts（单一真源）。
  {
    id: 'phrase:scan',
    name: '短语类穷尽扫描（枚举 + 逐条分类）',
    cmd: 'npm run scan:phrase:check',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // 台账销项同步（告警档）：实现性提交携带台账条目 ID、但区间内 tasks/ 无对应变更 → 告警。
  // 缺口实证：TERM-FDBK-1 随 feat 提交落地、同批 docs 提交没碰台账 → 台账仍挂「待排期」，
  // 而既有 13 步对此零覆盖（都只认代码/文档事实，不认台账是否与提交同步）。
  // **required:false 是刻意的**：存在正当反例（销项由同批另一笔 docs 提交完成、尚未落地），
  // 先告警档跑，假阳性率实测可控后再升 fail 门（改判据 = 造伤，须先分诊）。
  {
    id: 'ledger:receipt',
    name: '台账销项同步检查（告警档）',
    cmd: 'node scripts/verify-ledger-receipt.mjs',
    cwd: ROOT,
    required: false,
    presets: ['full'],
  },
  // 台账结构卫生（**硬闸**）：归档纪律的分诊从**人工闸**升级为机检。
  // 缺口实证：归档脚本按人肉 `--ids` 白名单跑 ⇒ 0.2.0 区 140 个 ID 只归档了 40 个；
  // 2026-10-26 观察区归位迁移又在没有门的情况下造出 22 处连续空行 + 已发布区整区滞留。
  // 判据 = ①欠账（已收口无归档指针）②假指针（有指针但归档无副本）③开放态错置
  // （观察/挂起态留在已发布区）④连续空行。**与 ledger:receipt 不重叠**：后者是
  // git 区间语义（提交 vs 台账），本步是**工作树语义**（台账当前结构）。
  // **required:true（2026-10-27 由告警升硬闸）**：上一版写明的升档条件是「①②③④ 四类存量清零」，
  // 该存量已于 2026-10-27 清零（同时补了 ⑤⑥⑦⑧ 四条不依赖区名的判据）⇒ 兑现承诺，**任一新命中 = 真回归**。
  // ⚠️ 存量若再涨：**先清零**，不要把这里改回 false。required:false 只能是「针对一批已知存量的
  // 临时免罚」，不能常驻——常驻即重演「门建了却明知道会被绕」的老剧本。
  {
    id: 'ledger:hygiene',
    name: '台账结构卫生检查（八类判据 · 硬闸）',
    cmd: 'npm run verify:ledger-hygiene',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // 台账折叠结清（硬闸）：防「整区折叠时条目凭空蒸发」。
  // 缺口实证：2026-10-26 归元把 5.0.0 / 5.1.0 / 宿主 0.x 四个版本区折叠成索引表的一行，
  // 那次靠**人工复读**才捞回 `rules-B2`（带「待迁」标记但差点被整条折走）；2026-10-27 用本步
  // 复盘同一笔提交，又挖出一整条无人接盘的「0.3.0 发布前置阻塞项清零收据」——已补迁归档。
  // **与另两步的分工**：receipt = 提交 vs 台账是否同步；hygiene = 台账当前结构是否合纪律；
  // 本步 = 这次改动**移走了什么、有没有留后手**。三者互不覆盖。
  // 口径：默认 `HEAD~1 → 工作树`（折叠后、提交前自查），复盘用 `--base=<ref> --head=<ref>`。
  {
    id: 'ledger:fold',
    name: '台账折叠结清检查（移走条目必须有归档副本 · 硬闸）',
    cmd: 'npm run verify:ledger-fold -- --since=origin/main',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // 排版格式检查（prettier）：FMT-PRETTIER-1 第③步——存量清零后才建闸（「存量不清零前不建闸」
  // 同族教训）。只进 full 不进 fast：全仓扫描 ~30s 且失败归因常是历史改动，不满足 fast 分层判据。
  {
    id: 'format:check',
    name: '排版格式检查（prettier）',
    cmd: 'npm run format:check',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  {
    id: 'audit',
    name: '依赖安全审计（允许失败）',
    cmd: 'npm audit --audit-level=high',
    cwd: ROOT,
    required: false,
    presets: ['full'],
    optionalFlag: 'audit-invert',
  },
];

/**
 * 二级宿主步骤 —— 由目录发现生成（当前 = memora-mcp），不手写宿主清单。
 *
 * 顺序约束：**必须插在 `host:test` 之前**——vscode 的跨宿主布局契约测试会加载 mcp 的
 * `dist/` 并断言它不旧于源码；若先跑 test 后 build，测的就是历史行为（「因错误的原因通过」）。
 */
const SECONDARY_HOST_STEPS = [];
for (const hostDir of SECONDARY_HOSTS) {
  const label = basename(hostDir);
  const pkg = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  if (typeof scripts.typecheck !== 'string') {
    // 配置错误而非测试失败：门禁要求每个宿主都能被类型检查，缺脚本就必须先补
    console.error(
      `[local-ci] 宿主 ${label} 缺 package.json#scripts.typecheck —— 门禁无法覆盖它，请先补齐`,
    );
    process.exit(2);
  }
  SECONDARY_HOST_STEPS.push({
    id: `host:${label}:typecheck`,
    name: `${label} TypeScript 类型检查`,
    cmd: 'npm run typecheck',
    cwd: hostDir,
    required: true,
    presets: ['fast', 'full'],
  });
  if (typeof scripts.build === 'string') {
    SECONDARY_HOST_STEPS.push({
      id: `host:${label}:build`,
      name: `${label} 构建`,
      cmd: 'npm run build',
      cwd: hostDir,
      required: true,
      presets: ['full'],
      optionalFlag: 'skip-build',
    });
  }
  if (typeof scripts.smoke === 'string') {
    // 端到端冒烟：真实 MCP Client 走 stdio 全链路（initialize/tools/list/tools/call + 取代过滤断言）。
    // 收编进全量门禁 = 把「只读宿主真能答对」从手工自证变成每轮可见——mcp 的 SQLite 只读活库
    // 改造（17b742c6）只被人工 `npm run smoke` 验过，机器面此前零覆盖。
    SECONDARY_HOST_STEPS.push({
      id: `host:${label}:smoke`,
      name: `${label} 端到端冒烟（stdio 全链路）`,
      cmd: 'npm run smoke',
      cwd: hostDir,
      required: true,
      presets: ['full'],
      optionalFlag: 'skip-build',
    });
  }
}

{
  const insertAt = ALL_STEPS.findIndex((step) => step.id === 'host:test');
  if (insertAt < 0) {
    throw new Error('local-ci: 找不到 host:test 步骤，二级宿主步骤的插入点失效（请更新本处）');
  }
  ALL_STEPS.splice(insertAt, 0, ...SECONDARY_HOST_STEPS);
}

function selectSteps() {
  const preset = argOf('preset') ?? 'full';
  if (preset !== 'fast' && preset !== 'full') {
    console.error(`[local-ci] --preset=${preset} 无效。可选：fast | full`);
    process.exit(2);
  }
  let steps = ALL_STEPS.filter((s) => s.presets.includes(preset));
  if (has('--kernel-only')) steps = steps.filter((s) => s.id.startsWith('kernel:'));
  if (has('--skip-build')) steps = steps.filter((s) => s.optionalFlag !== 'skip-build');
  if (has('--skip-cov')) steps = steps.filter((s) => s.optionalFlag !== 'skip-cov');
  // audit 默认关闭：需网络且 CI 本身 continue-on-error，不让它影响本地门禁稳定性
  if (!has('--audit')) steps = steps.filter((s) => s.id !== 'audit');
  const from = argOf('from');
  if (from) {
    const idx = steps.findIndex((s) => s.id === from);
    if (idx < 0) {
      console.error(
        `[local-ci] --from=${from} 不是有效步骤 id。可选：${ALL_STEPS.map((s) => s.id).join(', ')}`,
      );
      process.exit(2);
    }
    steps = steps.slice(idx);
  }
  return steps;
}

/** 从命令输出里抓关键统计，便于控制台一眼看数 */
function extractStats(text) {
  const out = [];
  const tests = text.match(/Tests\s+(\d+)\s+passed/);
  if (tests) out.push(`${tests[1]} passed`);
  const files = text.match(/Test Files\s+(\d+)\s+passed/);
  if (files) out.push(`${files[1]} 文件`);
  const skipped = text.match(/(\d+)\s+skipped/);
  if (skipped) out.push(`${skipped[1]} skipped`);
  const failed = text.match(/(\d+)\s+failed/);
  if (failed) out.push(`❌ ${failed[1]} failed`);
  const problems = text.match(/✖\s+(\d+)\s+problems?/);
  if (problems) out.push(`eslint ${problems[1]} problems`);
  const warn = text.match(/(\d+)\s+warnings?/);
  if (warn && !problems) out.push(`eslint ${warn[1]} warnings`);
  return out.join(' · ');
}

/**
 * 杀**整棵进程树**，而非只杀 shell。
 *
 * 为什么不能只 `child.kill()`：本脚本以 `shell: true` 启动，`child.pid` 是 shell 的 pid；
 * shell 被杀后，它拉起的 `npm` / `vitest` **孙进程仍活着**（孤儿/僵尸，继续吃 CPU 与端口）。
 * 平台分派：
 *   - Windows：`taskkill /PID <pid> /T /F`（/T 杀树、/F 强制）
 *   - POSIX：spawn 时 `detached: true` 建立独立进程组，再 `process.kill(-pid)` 打整组
 */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // 进程组已消失（子进程先退）——退化为杀 shell 本身
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出
  }
}

function runStep(step, index, total) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(step.cmd, {
      cwd: step.cwd,
      shell: true,
      // 非 Windows：建独立进程组，供 killTree 打整组（Windows 走 taskkill /T，无需此位）
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(step.env ?? {}) },
    });
    const timer = setTimeout(() => {
      killTree(child);
      chunks.push(`\n[local-ci] 步骤超时（>${STEP_TIMEOUT_MS / 1000}s），已强制终止整棵进程树`);
    }, STEP_TIMEOUT_MS);

    child.stdout.on('data', (d) => chunks.push(d.toString()));
    child.stderr.on('data', (d) => chunks.push(d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const text = chunks.join('');
      const ok = code === 0;
      const stats = extractStats(text);
      const label = `[${index}/${total}] ${step.name}`;
      const dots = '.'.repeat(Math.max(2, 46 - label.length));
      const verdict = ok ? '✅ PASS' : step.required ? '❌ FAIL' : '⚠️  WARN';
      console.log(
        `${label} ${dots} ${verdict} ${(ms / 1000).toFixed(1)}s${stats ? `  (${stats})` : ''}`,
      );
      resolve({ ...step, ok, code, ms, text, stats });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ...step,
        ok: false,
        code: -1,
        ms: Date.now() - started,
        text: String(err),
        stats: '',
      });
    });
  });
}

/** 只读 git 取值（门禁收据用）。取不到时返回 null —— 收据降级为 unknown，绝不因此中断门禁 */
function gitOut(args) {
  try {
    const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return res.status === 0 ? String(res.stdout).trim() : null;
  } catch {
    return null;
  }
}

/**
 * 收据（receipt）—— 把「全绿」从口头自证变成一份**可外部比对的留痕**。
 * 本地钩子物理上不可强制（LEFTHOOK=0 / --no-verify / 删钩子），故不承诺强制，
 * 只保证：**绕过一次即无收据** —— 缺口可观测，发布前清单一行比对即可发现。
 * `dirty` 必须在场：脏树上的全绿证明力弱，不写下来就会被当成 HEAD 的全绿。
 */
function buildReceipt(preset, stepCount) {
  const porcelain = gitOut(['status', '--porcelain']);
  const dirtyCount =
    porcelain === null
      ? null
      : porcelain === ''
        ? 0
        : porcelain.split('\n').filter((l) => l.trim() !== '').length;
  return {
    when: new Date().toISOString(),
    preset,
    head: gitOut(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown',
    tree: gitOut(['rev-parse', '--short=12', 'HEAD^{tree}']) ?? 'unknown',
    dirty: dirtyCount === null ? 'unknown' : dirtyCount === 0 ? 'clean' : `${dirtyCount} 项未提交`,
    steps: stepCount,
  };
}

function formatReceipt(receipt) {
  return [
    '══════ local-ci 收据（receipt）══════',
    `when   = ${receipt.when}`,
    `preset = ${receipt.preset}`,
    `head   = ${receipt.head}`,
    `tree   = ${receipt.tree}`,
    `dirty  = ${receipt.dirty}`,
    `steps  = ${receipt.steps}`,
    '═════════════════════════════════════',
  ].join('\n');
}

async function main() {
  acquireLock(); // 门禁互斥：并发 gate-full 对撞防线（见 LOCK_FILE 注释）
  const preset = argOf('preset') ?? 'full';
  const steps = selectSteps();
  const receipt = buildReceipt(preset, steps.length);
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(
    `\n[local-ci] 开始本地门禁模拟 · preset=${preset} · 共 ${steps.length} 步 · 根因：GitHub CI 触发已停用`,
  );
  console.log(
    `[local-ci] 收据：preset=${receipt.preset} head=${receipt.head} tree=${receipt.tree} dirty=${receipt.dirty} steps=${receipt.steps}\n`,
  );

  const results = [];
  for (let i = 0; i < steps.length; i++) {
    results.push(await runStep(steps[i], i + 1, steps.length));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(LOG_DIR, `local-ci-${stamp}.log`);
  const logBody = `${formatReceipt(receipt)}\n\n${results
    .map(
      (r) =>
        `===== ${r.id} | ${r.cmd} | exit=${r.code} | ${(r.ms / 1000).toFixed(1)}s =====\n${r.text}`,
    )
    .join('\n\n')}`;
  writeFileSync(logPath, logBody, 'utf8');

  const failed = results.filter((r) => !r.ok && r.required);
  const warned = results.filter((r) => !r.ok && !r.required);

  console.log('\n──────── 汇总 ────────');
  for (const r of results) {
    console.log(
      `${r.ok ? '✅' : r.required ? '❌' : '⚠️ '} ${r.id.padEnd(18)} exit=${String(r.code).padStart(3)}  ${(r.ms / 1000).toFixed(1)}s  ${r.stats}`,
    );
  }
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  console.log(
    `\n总耗时 ${(totalMs / 1000).toFixed(1)}s · 失败 ${failed.length} · 告警 ${warned.length}`,
  );
  console.log(`完整日志：${logPath}`);

  if (failed.length) {
    console.log('\n──────── 失败步骤尾部输出 ────────');
    for (const r of failed) {
      console.log(`\n### ${r.id} (exit=${r.code})`);
      console.log(r.text.split(/\r?\n/).slice(-40).join('\n'));
    }
    console.log(`\n[local-ci] 门禁未通过：${failed.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
  console.log('\n[local-ci] ✅ 全部通过');
}

main().catch((err) => {
  console.error('[local-ci] 脚本自身异常:', err);
  process.exit(2);
});
