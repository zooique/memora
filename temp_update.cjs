const fs = require("fs");
const file = "f:/zooique/memora/src/index.ts";
let content = fs.readFileSync(file, "utf8");

// 找到 WorkProjectionManager 的导出行
const oldExport = "export type { WorkProjectionEntry } from '@/agent/managers/workProjection.js';";
const newExport = "export type { WorkProjectionEntry } from '@/agent/managers/workProjection.js';\n// accumulateStream: 宿主可复用的 LLM 流式响应累积工具（用于生成标题、描述等短文本）\nexport { accumulateStream } from '@/agent/managers/streamAccumulator.js';";

content = content.replace(oldExport, newExport);

fs.writeFileSync(file, content, "utf8");
console.log("Updated index.ts");
