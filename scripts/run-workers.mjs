// Runs the discovery worker and the job worker in one container. If either exits, the other
// is stopped and the process exits non-zero so the platform restarts the container.
import { spawn } from "node:child_process";

const workers = ["worker:discovery", "worker:jobs"].map((script) => {
  const child = spawn("npm", ["run", script], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.error(`[workers] ${script} exited (${signal ?? code}); stopping`);
    for (const other of workers) if (other !== child && other.exitCode === null) other.kill("SIGTERM");
    process.exitCode = code || 1;
  });
  return child;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of workers) if (child.exitCode === null) child.kill(signal);
  });
}
