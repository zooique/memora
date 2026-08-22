# Memora

> Universal Agent Memory Kernel — Local-first, Private, Domain-agnostic. Everything is Memory.

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-87%25-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-2443%20passed-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**中文** → [README.md](./README.md)

---

## What is this?

Memora is an **Agent memory infrastructure** — it gives your AI Agent persistent, cross-session long-term memory.

It solves one core problem: **LLMs are stateless, but user tasks are continuous.**

Memora builds continuous evolution on top of stateless inference: memory persistence, intelligent recall, natural decay, semantic deduplication, conflict detection — a complete memory lifecycle, all running locally. Your data never leaves your machine.

## Design Philosophy

> **Everything is Memory.**
>
> Persona is "I remember who I am." Rules are "I remember how to behave." Skills are "I remember how to do certain things." Conversation history is "I remember what we talked about."

Memora is a **brain kernel that cannot run standalone** — it has interfaces but no "form." A CLI, WebUI, desktop sprite, or novel generator can be its "host." The host gives it a body (UI), blood vessels (Provider), and neural circuits (event loops).

## Core Capabilities

| Capability | Description |
|-----------|-------------|
| **Long-term Memory** | Cross-session, cross-topic memory persistence with intelligent recall |
| **Dual-channel Recall** | Semantic vector search + keyword search, hybridMerge fusion ranking |
| **Memory Governance L1-L4** | L1 semantic dedup → L2 timeliness eval → L3 conflict detection → L4 scheduled decay |
| **Agent-Persona Separation** | Agent is a pure memory engine; persona is a personality vessel. Switch personas without losing memories |
| **Unified Memory Model** | Everything is a "Memory" primitive, distinguished by open-string `source` — no closed enums |
| **Domain-agnostic** | Same architecture, different memory configs → different domains |
| **Node.js-only · Zero third-party runtime deps** | Depends on Node built-ins (`node:*`); no third-party runtime dependencies / native / host APIs. Persistence injected by host via interfaces |
| **Observability** | ITracer interface + structured spans, plug into any APM |

## Quick Start

### Install

```bash
npm install @zooique/memora
```

### Create an Agent

```typescript
import { Agent, createLlmProvider } from '@zooique/memora';

// Host responsibility: create an LLM Provider
// Works with any OpenAI Chat Completions-compatible service
const provider = createLlmProvider({
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

// Create Agent
const agent = new Agent({
  projectPath: '/path/to/project',
  provider,
  configDir: '/path/to/agent-config', // role-packs / skills
  dataDir: '.memora',                 // memory data directory
});

await agent.init();
```

### Chat (Streaming)

```typescript
for await (const chunk of agent.chat('Hi, remember that I love TypeScript')) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.content);
  }
}

// Next session — the agent automatically recalls "loves TypeScript"
const reply = await agent.chatSync('What language do I like?');
// → Answers based on recalled memory
```

### Memory Management

```typescript
// Search memories (hybrid: semantic + keyword)
const hits = await agent.memory.searchHybrid('TypeScript preference', { limit: 5 });

// Governance (exposed via agent.governance facade, LLM-judged)
const report = await agent.governance.deduplicate();
console.log(`Deduplicated ${report.deduplicatedCount} memories`);

const timeliness = await agent.governance.evaluateTimeliness();
const conflicts = await agent.governance.detectConflicts();

// Manual decay trigger (pure score decrease, no LLM call)
agent.governance.decay();
```

### Cleanup

```typescript
await agent.close();
```

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Host Application (CLI / Desktop Sprite / WebUI / Game)    │
│  ┌─────────────────┐    ┌──────────────────┐               │
│  │ LLM Provider     │◄───│ API Key / baseUrl │  ← Host job  │
│  └────────┬────────┘    └──────────────────┘               │
│           │ inject                                          │
│           ▼                                                 │
│  ┌──────────────────────────────────────────┐               │
│  │  Memora Kernel (Agent)                   │               │
│  │  - chat(input) → streaming response      │               │
│  │  - Dual-channel recall (semantic+keyword)│               │
│  │  - Memory governance (decay/dedup/conflict) │            │
│  │  - Role pack matching / Skill matching   │               │
│  │  - Tool registration / execution         │               │
│  │  - Session archive / external task loop  │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### Six Injectable Interfaces

The kernel interacts with the outside world through interfaces. Hosts inject implementations as needed:

| Interface | Responsibility | Built-in Implementation |
|-----------|---------------|------------------------|
| `IMemoryStorage` | Memory CRUD + search + decay | `InMemoryStorage` |
| `IVectorStore` | Semantic vector index | `JsonVectorStore` |
| `ISessionStore` | Session history persistence | None (host implements) |
| `ILogger` | Logging output | console fallback |
| `ITracer` | Observability spans | `NOOP_TRACER` |

## Project Structure

```
src/
├── index.ts          # Library exports (types + interfaces + functions + classes, no CLI)
├── agent/            # Agent facade + AgentLoop + seed/ (single-turn execution loop)
│   ├── agent.ts      # Facade class (single entry point for hosts)
│   ├── loop.ts       # Core loop (reason → tool call → reflection retry)
│   ├── assembler.ts  # Component assembler (pure factory)
│   ├── contextManager.ts / contextPreparer.ts / toolExecutor.ts / toolRunner.ts / checkpointRestoreCoordinator.ts ···
│   ├── seed/         # Minimal execution loop (prepare → act/difficulty → reflect, incl. external task outer loop)
│   └── managers/     # 16 specialized Managers/service classes (memoryInspector / memoryGovernance / roundSummaryGenerator / sessionManager / sessionArchiver / archiveCoordinator / workProjection / textPolishManager / chatLockManager, etc.)
├── memory/           # Memory engine (IMemoryStorage + InMemoryStorage + recall / hybrid ranking / vector / governance constants)
├── role-pack/        # Role packs (manifest parsing + validator + strategyResolver + capability mapping)
├── skill/            # Skill management (global pool + role-pack binding, progressive disclosure + skillScriptRunner)
├── llm/              # LLM adapter layer (provider + openaiCompatible + factory + embedding)
├── security/         # Security (path guard / write confirmation)
├── config/           # Config loading
├── code-exec/        # Generic code execution abstraction (conditionally exposed)
├── web-search/       # Web search abstraction (conditionally exposed)
├── web-fetch/        # Web fetch abstraction (conditionally exposed)
├── logging/          # Logging (ILogger interface + console fallback)
└── utils/            # Utilities (scanner / segmenter / event system / atomic write)
```

## Tech Stack

| Category | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | ADR-001 |
| Data Layer | IMemoryStorage interface (host injects persistence) | ADR-002 |
| LLM Protocol | OpenAI Chat Completions compatible (streaming SSE + Tool Calling) | ADR-003 |
| Memory Model | Open-string source primitive ("Everything is Memory" v2) | ADR-004 |
| Vector Search | IVectorStore interface + built-in JsonVectorStore (pure JS cosine similarity) | ADR-002 |
| Conflict Resolution | Memory conflicts resolved via supersededBy boolean flag | ADR-021 |
| Form Factor | Pure logic library (zero native deps, CLI/UI provided by host) | ADR-002 |
| Security | Two-level permissions + path whitelist + audit log | ADR-006 |
| Testing | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## Engineering Quality

| Metric | Value |
|--------|-------|
| Source | 104 production files (src/, zero third-party runtime deps) |
| Tests | 96 test files |
| Tests Passing | 2,443 passed / 1 skipped |
| Statement Coverage | 85.8% |
| Branch Coverage | 79.6% |
| Function Coverage | 88.5% |
| Line Coverage | 87.4% |
| Runtime Dependencies | **0** |
| Architecture Decision Records | 24 ADRs |

## Development

```bash
npm test             # Run tests
npm run test:cov     # Run tests + coverage
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run build        # Compile to dist/
```

## Documentation

- [Integration Guide](docs/memora-接入指南.md) — Complete host developer onboarding manual (Chinese)
- [API Reference](docs/memora-api-reference.md) — Public API quick reference (Chinese)
- [Config Example](config.example.json) — LLM / Embedding / Security config template

## Host Project

[memora-sprite](hosts/memora-sprite/) — An Electron-based desktop sprite host (v1.5.0), demonstrating a complete Memora integration: SQLite persistence, vector indexing, system tray, global shortcuts, and memory graph visualization.

## Why Memora?

| | Memora | Cloud memory services | Framework memory modules |
|---|---|---|---|
| Data privacy | ✅ 100% local | ❌ Cloud-dependent | ⚠️ Varies |
| Runtime deps | ✅ Zero | N/A (SaaS) | ❌ Heavy |
| Memory lifecycle | ✅ Full (dedup/decay/conflict) | ⚠️ Partial | ❌ CRUD only |
| Domain-agnostic | ✅ Open-string source | ⚠️ Opinionated | ⚠️ Framework-locked |
| Embeddable | ✅ Any Node.js host | ❌ API calls only | ⚠️ Framework-bound |
| Relation graph | ✅ Built-in sidecar | ❌ Rare | ❌ Rare |

## Contributing

This project follows the "Big Tree Model" engineering philosophy. Architecture Decision Records (ADRs) are in `.trae/decisions/`.

## License

[MIT](LICENSE)
