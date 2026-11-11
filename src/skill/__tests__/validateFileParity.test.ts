/**
 * 技能校验「双份一致性」漂移测试
 *
 * 背景：技能校验存在两份实现——
 * - 运行期真源：`src/skill/skillManager.ts#validateFile`（设置页健康徽章与加载期兜底消费）；
 * - 生成期预检镜像：`hosts/memora-vscode/src/extension/skills/_lib/verify-core.mjs`（被
 *   `skill-creator/scripts/verify-skill.mjs` 调用）。
 *
 * 两份实现天然会漂移（内核不能反向依赖宿主 `_lib`，脚本也无法在无内核环境里 import 内核包），
 * 且漂移没有任何既有测试会红。本测试即该漂移的守门：
 * 1. **夹具唯一来源** = `__tests__/fixtures/skill-validation-parity.json`。同一批文件落盘到临时
 *    workspace 后，内核 `validateFile` 与 `verify-skill.mjs` 的 `verifySkill()` 各跑一遍。
 *    脚本走**进程内 import**（不再 spawn 子进程）：6 个夹具 × 一次 node 冷启动会撞 vitest 默认
 *    10s 的 hookTimeout（台账 `TEST-TIMEOUT-FAKERED-1`）；CLI 面仍由宿主侧
 *    `skillCreatorVerify.test.ts` spawn 守护。
 * 2. 断言两侧判定（ok）与**共享判据的错误集合**一致；任何一侧单独改判据 → 本测试转红。
 * 3. 两侧允许的差异必须登记在夹具的 `allowedDifferences`（含理由），测试断言「不一致的用例
 *    恰好等于白名单」，既防漏登记，也防白名单悄悄过期（差异消失同样转红，逼人删白名单）。
 * 4. `valid` 夹具必须两侧都通过——否则「两边都恒错」也能让「一致」成立，是典型假绿。
 *
 * 跨包边界（尾巴 1 的收法 = 甲：显式 SKIP）：
 * 本测试位于内核测试目录，却要执行宿主侧 `verify-skill.mjs`。同仓检出时能跑，但内核包
 * 单独发布 / 单独检出（不带 `hosts/`）时必须**显式跳过并打印原因**，不允许静默放过，也不
 * 允许因 spawn ENOENT 变成含糊的假红。选择甲而不搬去宿主侧的理由：夹具与判据真源都在内核
 * （`validateFile` 是运行时真源），搬去宿主会让内核侧的漂移无人守门。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SkillManager } from '@/skill/skillManager.js';
import type { SkillValidation } from '@/skill/types.js';

/** 夹具里的单个用例（`files` 的值是逐行数组，写盘时以 \n 连接） */
interface ParityCase {
  id: string;
  diskName: string;
  files: Record<string, string[]>;
  expectedKernelOk: boolean;
  expectedScriptOk: boolean;
  expectedSharedErrors: string[];
}

/** 两侧允许的差异（必须写理由，禁止「大致等价」） */
interface AllowedDifference {
  id: string;
  check: string;
  kernel: { ok: boolean; level: string };
  script: { ok: boolean; level: string };
  reason: string;
}

/** 夹具文件整体结构 */
interface ParityFixture {
  sharedChecks: Record<string, string>;
  cases: ParityCase[];
  allowedDifferences: AllowedDifference[];
}

/** `verify-skill.mjs --json` 的 stdout 结构（进程内报告压平后与之同形） */
interface ScriptReport {
  ok: boolean;
  items: Array<{ level: string; check: string; message: string }>;
}

/** 宿主预检脚本导出的模块面（只声明本测试消费的部分） */
interface VerifySkillModule {
  verifySkill: (options: {
    skillFile: string;
    workspace?: string;
    userSkillsDir?: string;
    visibleNames?: string[];
    skipScripts?: boolean;
  }) => { ok: () => boolean; items: ScriptReport['items'] };
}

/** 单个用例在两侧的实际判定结果 */
interface CaseResult {
  fixtureCase: ParityCase;
  kernel: SkillValidation;
  script: ScriptReport;
}

/** 夹具文件绝对路径（本测试是该 JSON 的唯一消费者） */
const FIXTURE_FILE = fileURLToPath(
  new URL('./fixtures/skill-validation-parity.json', import.meta.url),
);

/** 仓库根：src/skill/__tests__/fixtures → 上四级 */
const REPO_ROOT = resolve(dirname(FIXTURE_FILE), '..', '..', '..', '..');

/** 生成期预检脚本（直接跑源码，不经 dist，避免依赖宿主构建产物） */
const VERIFY_SKILL_SCRIPT = join(
  REPO_ROOT,
  'hosts',
  'memora-vscode',
  'src',
  'extension',
  'skills',
  'skill-creator',
  'scripts',
  'verify-skill.mjs',
);

/** 用户要求的六类必需夹具（删掉任何一类都会让本测试转红，防止夹具集合被悄悄瘦身） */
const REQUIRED_CASE_IDS = [
  'valid',
  'name-mismatch',
  'missing-ref',
  'empty-description',
  'empty-body',
  'layer-invalid',
];

/**
 * 当前检出是否带宿主侧预检脚本。
 *
 * 内核包单独发布 / 单独检出时不包含 `hosts/`；此时本测试**显式跳过**（而不是红或静默绿），
 * 并把原因打印到测试输出，保证「跳过」是一个看得见的事实。
 */
const HOST_VERIFY_SCRIPT_AVAILABLE = existsSync(VERIFY_SKILL_SCRIPT);
if (!HOST_VERIFY_SCRIPT_AVAILABLE) {
  console.warn(
    `[SKIP] 未找到宿主侧预检脚本：${VERIFY_SKILL_SCRIPT}\n` +
      '原因：内核包单独检出/发布时不含 hosts/ 目录。夹具与判据真源仍在内核，' +
      '故本测试保留但显式跳过（不静默放过）；同仓检出时自动恢复执行。',
  );
}

/** 需要宿主脚本的用例统一用本别名：脚本缺席时注册为 skip（输出里显示跳过） */
const parityIt = HOST_VERIFY_SCRIPT_AVAILABLE ? it : it.skip;

/**
 * 读取唯一夹具来源
 * @returns 夹具结构
 */
function readFixture(): ParityFixture {
  return JSON.parse(readFileSync(FIXTURE_FILE, 'utf-8')) as ParityFixture;
}

/**
 * 把一个用例落盘到临时 workspace 的项目级技能目录
 * @param workspace 临时 workspace 根
 * @param fixtureCase 夹具用例
 * @returns 该用例的 SKILL.md 绝对路径
 */
function materializeCase(workspace: string, fixtureCase: ParityCase): string {
  const skillDir = join(workspace, '.memora', 'skills', fixtureCase.diskName);
  for (const [relPath, lines] of Object.entries(fixtureCase.files)) {
    const target = join(skillDir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, lines.join('\n'), 'utf-8');
  }
  return join(skillDir, 'SKILL.md');
}

/**
 * 进程内加载宿主预检脚本模块（模块级缓存：整份测试只解析一次）
 *
 * 为什么不 spawn：`beforeAll` 要跑 6 个夹具，每次 spawn 都是一次 node 冷启动，
 * 累加会撞 vitest 默认 10s 的 hookTimeout（台账 `TEST-TIMEOUT-FAKERED-1`）。
 * `@vite-ignore` 让 Vite 不尝试打包这个绝对文件路径，交给 Node 原生 ESM 加载。
 *
 * @returns 预检脚本模块（提供 `verifySkill`）
 */
function loadVerifySkillModule(): Promise<VerifySkillModule> {
  return import(
    /* @vite-ignore */ pathToFileURL(VERIFY_SKILL_SCRIPT).href
  ) as Promise<VerifySkillModule>;
}

/**
 * 在进程内跑一遍生成期预检，并把报告压平为与 CLI `--json` 输出同形的结构。
 *
 * `emitReport(report, { json: true })` 打印的就是 `{ ok: report.ok(), items: report.items }`，
 * 故压平后下方断言与「解析 stdout JSON」时期逐字等价，判定内容一字未改。
 *
 * @param verifySkill 预检脚本导出的校验函数
 * @param skillFile 被测技能文件绝对路径
 * @param workspace 临时 workspace 根（脚本用它做落点与重名基线）
 * @returns 脚本报告
 */
function runVerifySkill(
  verifySkill: VerifySkillModule['verifySkill'],
  skillFile: string,
  workspace: string,
): ScriptReport {
  const report = verifySkill({ skillFile, workspace, visibleNames: [], skipScripts: true });
  return { ok: report.ok(), items: report.items };
}

describe('技能校验双份一致性：内核 validateFile ↔ verify-skill 预检镜像', () => {
  const fixture = readFixture();
  /** 临时 workspace（所有用例落在同一目录，模拟真实项目里并存的多技能） */
  let workspace = '';
  /** 每个用例在两侧的实际判定 */
  let results: CaseResult[] = [];

  beforeAll(async () => {
    // 脚本缺席时不建 workspace、不加载模块：所有依赖它的用例已注册为 skip（原因见模块头）
    if (!HOST_VERIFY_SCRIPT_AVAILABLE) return;
    const { verifySkill } = await loadVerifySkillModule();
    workspace = join(tmpdir(), `memora-skill-parity-${Date.now()}`);
    results = [];
    for (const fixtureCase of fixture.cases) {
      const skillFile = materializeCase(workspace, fixtureCase);
      const kernel = await new SkillManager().validateFile(skillFile);
      results.push({
        fixtureCase,
        kernel,
        script: runVerifySkill(verifySkill, skillFile, workspace),
      });
    }
  });

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('夹具自锚：六类必需用例齐全，白名单写明理由，且「完全合法」用例两侧都通过', () => {
    const ids = fixture.cases.map((c) => c.id);
    for (const required of REQUIRED_CASE_IDS) expect(ids).toContain(required);

    // 白名单条目必须指向真实存在的用例，且理由不能是空话
    for (const diff of fixture.allowedDifferences) {
      expect(ids).toContain(diff.id);
      expect(diff.reason.trim().length).toBeGreaterThan(20);
    }

    // 防「两边都恒错」的假绿：合法夹具必须在两侧都判绿
    const valid = fixture.cases.find((c) => c.id === 'valid');
    expect(valid?.expectedKernelOk).toBe(true);
    expect(valid?.expectedScriptOk).toBe(true);
  });

  for (const fixtureCase of fixture.cases) {
    parityIt(`夹具「${fixtureCase.id}」：两侧判定与共享判据错误集合一致`, () => {
      const result = results.find((r) => r.fixtureCase.id === fixtureCase.id);
      if (!result) throw new Error(`未找到夹具「${fixtureCase.id}」的执行结果`);

      // 判据真源只认内核侧字段名；脚本侧字段经夹具 sharedChecks 映射回内核字段
      const scriptToKernelField = new Map<string, string>();
      for (const [kernelField, scriptCheck] of Object.entries(fixture.sharedChecks)) {
        scriptToKernelField.set(scriptCheck, kernelField);
      }
      const kernelErrors = new Set(
        result.kernel.issues
          .filter(
            (issue) =>
              issue.level === 'error' &&
              typeof issue.field === 'string' &&
              issue.field in fixture.sharedChecks,
          )
          .map((issue) => issue.field as string),
      );
      const scriptErrors = new Set(
        result.script.items
          .filter((item) => item.level === 'error' && scriptToKernelField.has(item.check))
          .map((item) => scriptToKernelField.get(item.check) as string),
      );

      // 1) 两侧总判定与夹具声明一致（声明值本身防「两边都恒错」）
      expect(result.kernel.ok).toBe(fixtureCase.expectedKernelOk);
      expect(result.script.ok).toBe(fixtureCase.expectedScriptOk);

      // 2) 声明必须被两侧实际检出（防某一侧漏检却因「两边都漏」而保持绿）
      for (const field of fixtureCase.expectedSharedErrors) {
        expect(kernelErrors.has(field)).toBe(true);
        expect(scriptErrors.has(field)).toBe(true);
      }

      const allowed = fixture.allowedDifferences.find((d) => d.id === fixtureCase.id);
      if (allowed) {
        // 3a) 白名单用例：断言声明的那对具体级别，不允许「大致等价」
        expect(
          result.kernel.issues.filter((i) => i.field === allowed.check).map((i) => i.level),
        ).toContain(allowed.kernel.level);
        expect(
          result.script.items.filter((i) => i.check === allowed.check).map((i) => i.level),
        ).toContain(allowed.script.level);
        expect(result.kernel.ok).toBe(allowed.kernel.ok);
        expect(result.script.ok).toBe(allowed.script.ok);
      } else {
        // 3b) 非白名单用例：两侧判定与共享判据错误集合必须完全相同
        expect(kernelErrors).toEqual(scriptErrors);
        expect(result.kernel.ok).toBe(result.script.ok);
      }
    });
  }

  parityIt('白名单完备：两侧不一致的用例恰好等于 allowedDifferences 声明', () => {
    const disagreements = results
      .filter((r) => r.kernel.ok !== r.script.ok)
      .map((r) => r.fixtureCase.id)
      .sort();
    expect(disagreements).toEqual(fixture.allowedDifferences.map((d) => d.id).sort());
  });
});
