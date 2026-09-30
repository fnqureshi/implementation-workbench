import { spawn } from "node:child_process";

const children = [];
let stopping = false;
const start = (label, command, args) => {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`${label} stopped unexpectedly${signal ? ` (${signal})` : ` (status ${code ?? "unknown"})`}. Stopping the Workbench so the UI cannot appear connected when its private bridge is unavailable.\n`);
    for (const running of children) if (running !== child) running.kill("SIGTERM");
    process.exitCode = code || 1;
  });
  return child;
};

process.stdout.write("Starting Implementation Workbench locally. No global settings are changed.\n");
start("Private bridge", process.execPath, ["bridge/server.mjs"]);
start("Web interface", "npm", ["run", "dev"]);

const stop = () => { stopping = true; for (const child of children) child.kill("SIGTERM"); };
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
