import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BLOCK_REASON_LABELS, defaultPort, resolveTarget, staticUrlBlockReason } from "@/modules/discovery/network-policy";
import { ANALYZED_EXTENSIONS, SKIPPED_DIRS, type SourceFile } from "@/modules/inventory/source";

/**
 * Fetches an authorized repository for static analysis, as safely as git allows:
 *
 * - https only, public hosts only (same SSRF policy as discovery), resolved address pinned so
 *   git can't be pointed elsewhere by DNS changes, redirects refused;
 * - shallow, single-branch, no tags, no submodules, no LFS, large blobs filtered out;
 * - no hooks, no symlinks, no user/system git config, no credential helpers or prompts;
 * - the access token (if any) is passed through the environment, never the command line,
 *   and scrubbed from every message;
 * - nothing from the repository is ever executed: files are read as text and discarded.
 */

export class RepoError extends Error {}

export type RepoLimits = { timeoutMs: number; maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
export const DEFAULT_REPO_LIMITS: RepoLimits = { timeoutMs: 120_000, maxFiles: 5_000, maxFileBytes: 512_000, maxTotalBytes: 50_000_000 };

/** file:// repositories are for tests only and are refused in production. */
const fileReposAllowed = () => process.env.NODE_ENV !== "production" && process.env.ANALYSIS_ALLOW_FILE_REPOS === "true";

function run(args: string[], env: Record<string, string | undefined>, cwd: string, timeoutMs: number, secrets: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      if (out.length > 1_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk).slice(-4_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new RepoError(`git couldn't start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const scrub = (s: string) => secrets.filter(Boolean).reduce((acc, secret) => acc.split(secret).join("••••••"), s);
      if (code === 0) return resolve(out.trim());
      const last = scrub(err).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 400);
      reject(new RepoError(signal ? `git was stopped after ${Math.round(timeoutMs / 1000)}s` : `git failed: ${last || `exit code ${code}`}`));
    });
  });
}

export async function cloneRepository(repoUrl: string, branch: string | null, token: string | null, limits: RepoLimits = DEFAULT_REPO_LIMITS): Promise<{ dir: string; commitSha: string; cleanup: () => Promise<void> }> {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new RepoError("The repository URL isn't valid.");
  }
  if (url.username || url.password) throw new RepoError("Repository URLs must not contain credentials.");
  const isFile = url.protocol === "file:";
  if (isFile ? !fileReposAllowed() : url.protocol !== "https:") throw new RepoError("Only https:// repositories can be analysed.");
  if (branch !== null && (!/^[\w./-]{1,200}$/.test(branch) || branch.startsWith("-") || branch.includes(".."))) throw new RepoError("Invalid branch name.");

  const config: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.symlinks", "false"],
    ["core.fsmonitor", "false"],
    ["protocol.allow", "never"],
    [isFile ? "protocol.file.allow" : "protocol.https.allow", "always"],
    ["http.followRedirects", "false"],
    ["credential.helper", ""],
    ["submodule.recurse", "false"],
    ["transfer.fsckObjects", "true"],
  ];
  if (!isFile) {
    const block = staticUrlBlockReason(url.toString());
    if (block) throw new RepoError(`Repository host blocked: ${BLOCK_REASON_LABELS[block]}.`);
    const port = defaultPort(url);
    const target = await resolveTarget(url.hostname, port);
    if (!target.ok) throw new RepoError(`Repository host blocked: ${target.detail}.`);
    // Pin the vetted address so a DNS change between check and fetch can't redirect git.
    config.push(["http.curloptResolve", `${url.hostname}:${port}:${target.family === 6 ? `[${target.address}]` : target.address}`]);
    if (token) config.push(["http.extraHeader", `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "qa-repo-"));
  const home = await mkdtemp(path.join(tmpdir(), "qa-git-home-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  };
  // A minimal environment: nothing from the worker's own environment leaks into git.
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
  };
  const secrets = token ? [token, Buffer.from(`x-access-token:${token}`).toString("base64")] : [];
  try {
    const args = ["clone", "--depth", "1", "--single-branch", "--no-tags", "--no-recurse-submodules", "--filter=blob:limit=512k", ...(branch ? ["--branch", branch] : []), "--", url.toString(), dir];
    await run(args, env, home, limits.timeoutMs, secrets);
    const commitSha = await run(["rev-parse", "HEAD"], env, dir, 10_000, secrets);
    if (!/^[0-9a-f]{40,64}$/.test(commitSha)) throw new RepoError("Couldn't read the checked-out commit.");
    return { dir, commitSha, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Reads analyzable text files (never following symlinks), within limits. */
export async function readSourceTree(root: string, limits: RepoLimits = DEFAULT_REPO_LIMITS): Promise<{ files: SourceFile[]; skipped: number; truncated: boolean; bytes: number }> {
  const files: SourceFile[] = [];
  let bytes = 0;
  let skipped = 0;
  let truncated = false;
  const walk = async (dir: string) => {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!info.isFile() || !ANALYZED_EXTENSIONS.test(entry.name)) continue;
      if (info.size > limits.maxFileBytes || /\.min\.[cm]?js$/.test(entry.name)) {
        skipped++;
        continue;
      }
      if (files.length >= limits.maxFiles || bytes + info.size > limits.maxTotalBytes) {
        truncated = true;
        return;
      }
      const content = await readFile(full, "utf8");
      if (content.includes("\u0000")) {
        skipped++;
        continue;
      }
      bytes += info.size;
      files.push({ path: path.relative(root, full).split(path.sep).join("/"), content });
    }
  };
  await walk(root);
  return { files, skipped, truncated, bytes };
}
