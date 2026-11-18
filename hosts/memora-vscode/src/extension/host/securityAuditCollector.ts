/**
 * securityAuditCollector — 路径守卫安全审计收集器（自 chatPanel 外置，行数闸门拆法）
 *
 * 域职责：订阅 `agent.security.onAudit`（内核 SecurityGuard 在路径读/写审批时产出审计
 * 事件），累计 total / denied 计数 + 保留最近若干条（默认 3）供可观测折叠区展示。
 *
 * **边界**：只做收集与计数，不判读安全语义——「哪些 type 算拒绝」（path-deny /
 * write-decline）跟随内核审计类型面，本域只按名单累加，不新增第二判据。
 *
 * 为什么外置：`chatPanel.ts` 贴 `max-lines` 基线（只降不升），本域是自足的「订阅 →
 * 累计 → 快照 → 退订」闭环（与 `activeFileTracker` 同一拆法）——面板留薄壳。
 *
 * @module securityAuditCollector
 */

/** 单条审计摘要行（路径取 basename，不泄露完整目录结构；透出内核拒绝原因） */
export interface SecurityAuditRow {
  type: string;
  path: string;
  tool?: string;
  reason?: string;
}

/** 供快照推送的只读快照（字段与 PanelSnapshots.getSecurityAudit 消费形状一致） */
export interface SecurityAuditSnapshot {
  total: number;
  denied: number;
  recent: SecurityAuditRow[];
}

/** 窄接口：只需要 onAudit 订阅面（duck-type 内核 SecurityGuard，不引内核类型强依赖） */
interface AuditableGuard {
  onAudit(listener: (event: unknown) => void): () => void;
}

/**
 * 创建收集器（面板唯一实例；bind 幂等——先退订旧订阅再绑新，防重复计数）
 *
 * @param keep 最近审计保留条数（默认 3，与原 chatPanel 内联实现同值）
 */
export function createSecurityAuditCollector(keep = 3) {
  let total = 0;
  let denied = 0;
  let unsub: (() => void) | undefined;
  const recent: SecurityAuditRow[] = [];

  return {
    /** 只读快照（recent 引用直传：消费方只读不持有，与原字段共享语义） */
    snapshot(): SecurityAuditSnapshot {
      return { total, denied, recent };
    },
    /** 退订（幂等；面板销毁 / 换实例前调用） */
    dispose(): void {
      unsub?.();
      unsub = undefined;
    },
    /**
     * 绑定守卫（幂等重绑；guard 缺省 = 静默返回，供装配未完成的容错路径）
     *
     * 回调累积计数 + 保底最近 `keep` 条（duck-type 匹配内核 AuditEvent，避免强依赖内部类型）。
     * 透出内核拒绝原因（path-deny / write-decline 含 reason 如「命中黑名单」「路径越界」）：
     * 丢弃 reason 则用户只看到「拒绝」却不知为何。
     */
    bind(guard: AuditableGuard | null | undefined): void {
      this.dispose();
      if (!guard) return;
      unsub = guard.onAudit((event) => {
        const audit = event as { type?: string; path?: string; tool?: string; reason?: string };
        const type = audit.type ?? 'audit';
        const path = audit.path ?? '';
        total += 1;
        if (type === 'path-deny' || type === 'write-decline') {
          denied += 1;
        }
        // 路径取 basename 防折叠区冗长（可读且不泄露完整目录结构）
        const base = path.split(/[\\/]/).pop() ?? path;
        recent.push({ type, path: base, tool: audit.tool, reason: audit.reason });
        if (recent.length > keep) recent.shift();
      });
    },
  };
}
