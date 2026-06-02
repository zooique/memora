/**
 * 路径白名单
 *
 * 4 类允许 + 6 类禁止
 * 详见 安全权限设计 v0.1.md §4 + ADR-006
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const BLOCKED_PATTERNS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.env(\.|$)/i,
  /[\\/]system32([\\/]|$)/i,
  /[\\/]Windows[\\/]System/i,
  /[\\/]etc[\\/]passwd/i,
];

export class SecurityGuard {
  constructor(
    private readonly projectPath: string,
    private readonly dataDir: string,
    private readonly extraAllowedPaths: string[] = [],
  ) {}

  /**
   * 断言路径允许访问
   * @throws Error 不在白名单时
   */
  assertPathAllowed(absolutePath: string): void {
    const resolved = resolve(absolutePath);

    // 1. 黑名单优先
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(resolved)) {
        throw new Error(`禁止访问：路径命中黑名单规则 (${pattern})`);
      }
    }

    // 2. 白名单：项目目录
    if (resolved.startsWith(resolve(this.projectPath))) return;

    // 3. 白名单：数据目录
    const memoraDir = resolve(this.dataDir.replace(/^~/, homedir()));
    if (resolved.startsWith(memoraDir)) return;

    // 4. 白名单：用户显式声明
    for (const allowed of this.extraAllowedPaths) {
      if (resolved.startsWith(resolve(allowed))) return;
    }

    throw new Error(`路径越界：${resolved} 不在白名单内`);
  }
}
