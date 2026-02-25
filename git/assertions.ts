import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitResult } from "./utils";

export interface GitIdentity {
  email: string;
  name: string;
}

export interface GitRunOptions {
  cwd?: string;
}

export type RunGitFn = (
  args: string[],
  options?: GitRunOptions,
) => Promise<GitResult>;

export async function runGitChecked(
  runGit: RunGitFn,
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  const result = await runGit(args, options);
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

export async function configureGitIdentity(
  runGit: RunGitFn,
  cwd: string,
  identity: GitIdentity,
): Promise<void> {
  await runGitChecked(runGit, ["config", "user.email", identity.email], {
    cwd,
  });
  await runGitChecked(runGit, ["config", "user.name", identity.name], {
    cwd,
  });
}

export async function createUpstreamRepo(
  runGit: RunGitFn,
  baseDir: string,
  name: string,
  identity: GitIdentity,
): Promise<string> {
  const upstreamPath = join(baseDir, `${name}.git`);
  const seedPath = join(baseDir, `${name}-seed`);

  await runGitChecked(runGit, ["init", "--bare", upstreamPath]);

  mkdirSync(seedPath, { recursive: true });
  await runGitChecked(runGit, ["init"], { cwd: seedPath });
  await configureGitIdentity(runGit, seedPath, identity);

  writeFileSync(join(seedPath, "README.md"), `# ${name}\n`);
  await runGitChecked(runGit, ["add", "."], { cwd: seedPath });
  await runGitChecked(runGit, ["commit", "-m", "initial commit"], {
    cwd: seedPath,
  });
  await runGitChecked(runGit, ["branch", "-M", "main"], { cwd: seedPath });
  await runGitChecked(runGit, ["remote", "add", "origin", upstreamPath], {
    cwd: seedPath,
  });
  await runGitChecked(runGit, ["push", "-u", "origin", "main"], {
    cwd: seedPath,
  });

  // Ensure clones default to main.
  await runGitChecked(runGit, ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: upstreamPath,
  });

  rmSync(seedPath, { recursive: true, force: true });

  return upstreamPath;
}

export async function pushCommitToUpstream(
  runGit: RunGitFn,
  baseDir: string,
  upstreamPath: string,
  fileName: string,
  content: string,
  identity: GitIdentity,
): Promise<string> {
  const workDir = join(
    baseDir,
    `upstream-push-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await runGitChecked(runGit, ["clone", upstreamPath, workDir]);
  await configureGitIdentity(runGit, workDir, identity);

  writeFileSync(join(workDir, fileName), content);
  await runGitChecked(runGit, ["add", fileName], { cwd: workDir });
  await runGitChecked(runGit, ["commit", "-m", `update ${fileName}`], {
    cwd: workDir,
  });
  await runGitChecked(runGit, ["push", "origin", "main"], { cwd: workDir });

  const newSha = await runGitChecked(runGit, ["rev-parse", "HEAD"], {
    cwd: workDir,
  });

  rmSync(workDir, { recursive: true, force: true });

  return newSha;
}
