import { Glob } from "bun";

const locks = new Map<string, Promise<void>>();

export async function withLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  while (locks.has(lockKey)) {
    await locks.get(lockKey);
  }

  let release!: () => void;
  locks.set(
    lockKey,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  try {
    return await fn();
  } finally {
    locks.delete(lockKey);
    release();
  }
}

export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function git(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    fullEnv?: boolean;
  } = {},
): Promise<GitResult> {
  const { cwd, env, fullEnv = false } = options;

  let finalEnv: Record<string, string>;
  if (fullEnv) {
    finalEnv = Object.assign({}, env);
  } else {
    finalEnv = Object.assign({}, process.env, env);
  }

  const proc = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    env: finalEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    success: exitCode === 0,
    stdout,
    stderr,
    exitCode,
  };
}

export function matchesAnyPattern(
  path: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    let normalizedPattern = pattern;
    if (pattern.endsWith("/") && !pattern.endsWith("**/")) {
      normalizedPattern = pattern.slice(0, -1) + "/**";
    }

    const glob = new Glob(normalizedPattern);
    return (
      glob.match(path) ||
      (pattern.endsWith("/") && new Glob(pattern.slice(0, -1)).match(path))
    );
  });
}

export function branchMatchesPattern(
  branch: string,
  patterns: readonly string[],
): boolean {
  const branchName = branch.replace(/^refs\/heads\//, "");
  return matchesAnyPattern(branchName, patterns);
}
