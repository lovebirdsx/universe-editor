#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

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

function safePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function localTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
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

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const outDir = path.join(projectDir, ".claude", "explore-results");

  fs.mkdirSync(outDir, { recursive: true });

  const sessionId = safePart(input.session_id);
  const agentId = safePart(input.agent_id);
  const timestamp = localTimestamp();

  const outPath = path.join(
    outDir,
    `${timestamp}-${sessionId}-${agentId}.md`
  );

  const content = [
    "# Explore subagent result",
    "",
    `- session_id: ${input.session_id || ""}`,
    `- agent_id: ${input.agent_id || ""}`,
    `- agent_type: ${input.agent_type || ""}`,
    `- agent_transcript_path: ${input.agent_transcript_path || ""}`,
    "",
    "## Final message",
    "",
    input.last_assistant_message || ""
  ].join("\n");

  fs.writeFileSync(outPath, content, "utf8");

  process.stdout.write(
    JSON.stringify({
      systemMessage: `Saved Explore result to ${outPath}`
    }) + "\n"
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});