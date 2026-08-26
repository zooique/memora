const fs = require("fs");
const file = "f:/zooique/memora/hosts/memora-vscode/src/extension/extension.ts";
let content = fs.readFileSync(file, "utf8");

// 1. 添加 accumulateStream 导入（在 Agent 导入后面）
const oldImport = "import type { Agent } from '@zooique/memora';";
const newImport = "import type { Agent } from '@zooique/memora';\nimport { accumulateStream } from '@zooique/memora';";
content = content.replace(oldImport, newImport);

// 2. 替换 LLM 调用部分
const oldLlmCall = `        // 调用 LLM 自动生成一句话描述
        const prompt = '请用一句话描述这个文件的用途（不超过 30 字）：\\n\\n' + text;
        const llmResult = await agent.provider.call([
          { role: 'user', content: prompt }
        ], { maxTokens: 60 });
        const description = llmResult.text.trim();`;

const newLlmCall = `        // 调用 LLM 自动生成一句话描述（使用 accumulateStream 累积流式响应）
        const prompt = '请用一句话描述这个文件的用途（不超过 30 字）：\\n\\n' + text;
        const description = (await accumulateStream(agent.provider, [
          { role: 'user', content: prompt }
        ], { maxTokens: 60 })).trim();`;

content = content.replace(oldLlmCall, newLlmCall);

fs.writeFileSync(file, content, "utf8");
console.log("Updated extension.ts");
