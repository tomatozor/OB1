/**
 * Runs the socket-free Deno black-box harness from the historical Node entrypoint.
 * Run from server/: node test-stateless.mjs
 */
import { spawn } from "node:child_process";

const child = spawn(
  "deno",
  ["run", "--allow-env", "tests/stateless-blackbox.ts"],
  {
    cwd: new URL(".", import.meta.url),
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`stateless harness exited on signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
