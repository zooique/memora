#!/usr/bin/env node
/**
 * Node 版本钉版断言（`ENV-COV-1` 判据① —— 「使环境确定」，**不是**修覆盖率红根因）
 *
 * 存在的理由：覆盖率闸门曾出现「同一命令、同一 commit、同一天，既红 74.3 又绿 86.9」。
 * 排查时最毒的一次误判是**把 pin 当 runtime**——报告里写「窗口前后均 v22.22.2」，
 * 那个值取自 `.nvmrc` 的**钉值**，而实跑是 v24.12.0。错误的排除比不排除更毒：
 * 它会主动把后续排查引到错方向。本断言就是把「意图」与「事实」的对账变成机器动作。
 *
 * 判据（任一命中即红）：
 *   ① **实跑 == 钉值**：`process.versions.node` 的 major 必须等于 `.nvmrc` 的 major。
 *      失配时给出可执行处置（`nvm use`）——这不是代码回归，报错必须一眼看出是环境。
 *   ② **CI == 钉值**：每个 GitHub workflow 都必须声明 `node-version`，且 major 等于钉值。
 *      防「本机钉 22、CI 跑 24」——那等于门禁在两种环境下各判一次红绿，比不钉更糟。
 *   ③ **钉值落在自己声明的支持区间内**：`engines.node` 的下界 major 不得高于钉值
 *      （钉值连自己声明的门槛都不满足 = 配置自相矛盾）。
 *   ④ **射程下限**：`.nvmrc` 非空、`engines.node` 存在、至少扫到一个 workflow
 *      且其中至少一条 `node-version`——否则判据全部建立在空集上而恒绿。
 *
 * 插点：`package.json#scripts.test:cov` 的前置（不是 `local-ci` 的独立步骤）——
 *   覆盖率可从 npm 脚本、门禁、手工三种入口发起，挂在唯一的那条链上才叫单点。
 *
 * 用法：
 *   node scripts/verify-node-pin.mjs             # 主跑
 *   node scripts/verify-node-pin.mjs --self-test # 自检：纯函数注入变异，确认判据能红
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 取版本串的 major（容忍 `v` 前缀、`>=` / `^` 等范围符号） */
function majorOf(version) {
  const m = /(?<major>\d+)/.exec(String(version).trim());
  return m ? Number(m.groups.major) : NaN;
}

/**
 * 判据本体（纯函数，便于自检注入）：入参全是已解析事实，返回问题列表；空数组 = 绿。
 *
 * @param {object} input
 * @param {string} input.runtime   实跑版本（`process.versions.node`）
 * @param {string} input.pin       `.nvmrc` 原文
 * @param {string} input.engines   `package.json#engines.node`
 * @param {{file:string,versions:string[]}[]} input.workflows 每个 workflow 抽到的 node-version
 */
export function auditNodePin({ runtime, pin, engines, workflows }) {
  const issues = [];
  const pinMajor = majorOf(pin);
  const runtimeMajor = majorOf(runtime);
  const enginesMajor = majorOf(engines);

  // 判据④ 射程下限（先查：空集会让 ①②③ 静默变绿）
  if (Number.isNaN(pinMajor)) issues.push(`.nvmrc 无法解析出 major：${JSON.stringify(pin)}`);
  if (!engines || Number.isNaN(enginesMajor)) {
    issues.push(`package.json#engines.node 缺失或无法解析：${JSON.stringify(engines)}`);
  }
  if (!Array.isArray(workflows) || workflows.length === 0) {
    issues.push('未扫到任何 workflow（判据② 将建立在空集上）');
  }

  // 判据① 实跑 == 钉值
  if (!Number.isNaN(pinMajor) && runtimeMajor !== pinMajor) {
    issues.push(
      `实跑 node major = ${runtimeMajor}（v${runtime}）≠ 钉值 ${pinMajor}（.nvmrc）\n` +
        `     这不是代码回归，是环境未对齐。处置：在仓库根跑 \`nvm use\`（读 .nvmrc），` +
        `或确认 PATH 上的 node 不是别的工具链注入的。`,
    );
  }

  // 判据② CI == 钉值
  for (const wf of workflows ?? []) {
    if (!wf.versions || wf.versions.length === 0) {
      issues.push(`${wf.file} 未声明 node-version（该 workflow 的 node 版本不受约束）`);
      continue;
    }
    for (const v of wf.versions) {
      if (majorOf(v) !== pinMajor) {
        issues.push(`${wf.file} 的 node-version = ${v} ≠ 钉值 ${pinMajor}`);
      }
    }
  }

  // 判据③ 钉值落在 engines 声明的区间内
  if (!Number.isNaN(pinMajor) && !Number.isNaN(enginesMajor) && enginesMajor > pinMajor) {
    issues.push(
      `engines.node 下界 ${enginesMajor} 高于钉值 ${pinMajor}——钉值不满足自己声明的支持门槛`,
    );
  }

  return issues;
}

/** 从 workflow 原文抽所有 `node-version:` 的取值（含 `'22'` / `"22"` / `22` 三形态） */
function extractNodeVersions(text) {
  return [...text.matchAll(/node-version:\s*['"]?(?<v>[^'"\s]+)['"]?/g)].map((m) => m.groups.v);
}

function loadReal() {
  const wfDir = join(ROOT, '.github', 'workflows');
  const files = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  return {
    runtime: process.versions.node,
    pin: readFileSync(join(ROOT, '.nvmrc'), 'utf8'),
    engines: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node,
    workflows: files.map((file) => ({
      file,
      versions: extractNodeVersions(readFileSync(join(wfDir, file), 'utf8')),
    })),
  };
}

/**
 * 自检：以**真实文件**为基线注入变异。实跑版本无法注入（不换 node 进程），
 * 故 ① 的变异体直接改入参的 runtime 字段——判据本体是纯函数，这是它存在的理由。
 */
function selfTest() {
  const base = loadReal();
  const cases = [
    {
      label: '① 实跑 major ≠ 钉值',
      mutate: (d) => {
        d.runtime = `${Number(majorOf(d.pin)) + 2}.0.0`;
      },
      expect: '实跑 node major',
    },
    {
      label: '② CI 与钉值漂移',
      mutate: (d) => {
        d.workflows[0].versions = [`${Number(majorOf(d.pin)) + 2}`];
      },
      expect: '≠ 钉值',
    },
    {
      label: '② workflow 未声明 node-version',
      mutate: (d) => {
        d.workflows[0].versions = [];
      },
      expect: '未声明 node-version',
    },
    {
      label: '③ engines 下界高于钉值',
      mutate: (d) => {
        d.engines = `>=${Number(majorOf(d.pin)) + 1}.0.0`;
      },
      expect: '高于钉值',
    },
    {
      label: '④ 未扫到 workflow',
      mutate: (d) => {
        d.workflows = [];
      },
      expect: '未扫到任何 workflow',
    },
    {
      label: '④ .nvmrc 不可解析',
      mutate: (d) => {
        d.pin = 'lts/*';
      },
      expect: '.nvmrc 无法解析',
    },
  ];
  let allOk = true;
  for (const c of cases) {
    // 深拷贝：每个变异体互不污染。用 JSON 往返而非 structuredClone——
    // 入参全是 JSON 形状（字符串/数组/对象），且本仓根 eslint 的 globals 未声明后者。
    const data = JSON.parse(JSON.stringify(base));
    c.mutate(data);
    const issues = auditNodePin(data);
    const hit = issues.some((s) => s.includes(c.expect));
    console.log(
      `  ${hit ? '✅' : '❌'} ${c.label}${hit ? ' 被捕获' : ` 未被捕获（实际：${issues[0] ?? '无问题'}）`}`,
    );
    if (!hit) allOk = false;
  }
  // 反例控制：真实文件必须绿（防过度拦截）
  const clean = auditNodePin(base);
  const cleanOk = clean.length === 0;
  console.log(
    `  ${cleanOk ? '✅' : '❌'} 反例：真实文件${cleanOk ? '保持全绿' : `被误报：${clean.join(' / ')}`}`,
  );
  if (!cleanOk) allOk = false;
  console.log(allOk ? '\n✅ 自检通过：钉版各判据均可捕获变异' : '\n❌ 自检失败：存在失明判据');
  return allOk ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const data = loadReal();
  const issues = auditNodePin(data);
  const pinMajor = majorOf(data.pin);
  if (issues.length === 0) {
    console.log(
      `✅ [node-pin] 环境已确定：实跑 v${data.runtime} / 钉值 major ${pinMajor} / ` +
        `${data.workflows.length} 个 workflow 一致 / engines ${data.engines}`,
    );
    return 0;
  }
  console.error(`❌ [node-pin] ${issues.length} 处命中：`);
  for (const s of issues) console.error(`   ${s}`);
  console.error(
    '   处置：环境未对齐 ⇒ 仓库根 `nvm use`；CI 与钉值漂移 ⇒ 改 workflow 或改 .nvmrc（二者必须同时动）；\n' +
      '   禁止为了让本步变绿而去改覆盖率阈值——阈值 SSOT 在 vitest.config.ts，改它就是改判据迁就环境。',
  );
  return 1;
}

process.exit(main());
