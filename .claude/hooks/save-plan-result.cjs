#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", chunk => {
      data += chunk;
    });

    process.stdin.on("end", () => {
      resolve(data);
    });

    process.stdin.on("error", reject);
  });
}

async function main() {
  const rawInput = await readStdin();

  let input;
  try {
    input = JSON.parse(rawInput);
  } catch (err) {
    console.error("Failed to parse hook input JSON:", err.message);
    process.exit(1);
  }

  const filePath = input.tool_input?.file_path || "";
  if (!filePath) process.exit(0);

  const globalPlansDir = path.join(os.homedir(), ".claude", "plans");
  const normalizedFile = path.normalize(filePath);
  const normalizedPlansDir = path.normalize(globalPlansDir);

  if (!normalizedFile.startsWith(normalizedPlansDir + path.sep) && normalizedFile !== normalizedPlansDir) {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const outDir = path.join(projectDir, ".claude", "plans");
  fs.mkdirSync(outDir, { recursive: true });

  const planContent = fs.readFileSync(normalizedFile, "utf8");
  const baseName = path.basename(normalizedFile);
  const outPath = path.join(outDir, baseName);

  fs.writeFileSync(outPath, planContent, "utf8");

  process.stdout.write(
    JSON.stringify({
      systemMessage: `Saved plan to ${outPath}`
    }) + "\n"
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
