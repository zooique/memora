/**
 * 代码执行提供者接口定义：让 memora 内核具备可注入的通用代码执行能力。
 * 宿主实现 ICodeExecutionProvider 注入沙箱执行器（接口注入，遵循 IWebSearchProvider 模式；零依赖）。
 *
 * 与 run_skill_script 的区别：
 * - run_skill_script 绑定技能目录内的脚本文件（执行器由内核内置，子进程沙箱）；
 * - run_code 是通用的「模型写代码 → 执行 → 结果回填」能力，执行器**由宿主注入**。
 *
 * 安全注意：内核不内置沙箱执行器（保持零依赖），执行器的隔离等级与可用语言由宿主决定。
 */

/** 代码执行结果 */
export interface CodeExecutionResult {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码（0 = 成功） */
  exitCode: number;
  /** 是否超时 */
  timedOut: boolean;
}

/** 代码执行选项 */
export interface CodeExecutionOptions {
  /** 执行超时（毫秒，默认 30000，最大 120000） */
  timeoutMs?: number;
  /** 工作目录（可选，未传由执行器决定） */
  cwd?: string;
}

/**
 * 代码执行提供者接口：宿主实现并注入 AgentOptions.codeExecutionProvider 提供执行能力；
 * 未注入时 Agent 不会暴露 run_code 工具给 LLM。
 */
export interface ICodeExecutionProvider {
  /**
   * 执行器支持的语言清单（可选声明，命令执行能力方案 §10.4-①(b)）：小写语言别名
   * （如 ["javascript", "js", "nodejs", "node"]）。
   * 声明后内核 run_code 工具描述按实际生成「支持：a、b、c」——消灭「描述承诺 python、
   * 宿主只支持 JS」的描述与现实不符（§10.3 实锤）；未声明（undefined / 空数组）→
   * 描述退化为现行去承诺文案，对模型不列举（零感知，向后兼容，命令执行能力方案 §11.6 拍板）。
   * 支持列表真源在本字段（宿主执行器自知），内核与工具描述均从它派生，不双写。
   */
  readonly supportedLanguages?: readonly string[];
  /** 执行代码字符串，返回 stdout/stderr/exitCode/timedOut */
  execute(
    code: string,
    language: string,
    options?: CodeExecutionOptions,
  ): Promise<CodeExecutionResult>;
}
