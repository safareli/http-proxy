import { describe, expect, test } from "bun:test";
import {
  branchMatchesPattern,
  git,
  matchesAnyPattern,
  withLock,
} from "./utils";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setWithUndo(
  target: Record<string, string | undefined>,
  values: Record<string, string | undefined>,
): () => void {
  const previous: Record<string, string | undefined> = {};
  const existedBefore: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(values)) {
    existedBefore[key] = Object.hasOwn(target, key);
    previous[key] = target[key];

    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }

  return () => {
    for (const key of Object.keys(values)) {
      if (!existedBefore[key]) {
        delete target[key];
        continue;
      }

      target[key] = previous[key];
    }
  };
}

function setEnvVars(values: Record<string, string | undefined>): () => void {
  return setWithUndo(process.env as Record<string, string | undefined>, values);
}

describe("git/utils.ts", () => {
  describe("setWithUndo()", () => {
    test("applies changes and undoes them", () => {
      const target: Record<string, string | undefined> = {
        A: "1",
        B: "2",
      };

      const undo = setWithUndo(target, {
        A: "10",
        B: undefined,
        C: "3",
      });

      expect(target).toEqual({ A: "10", C: "3" });
      expect(Object.hasOwn(target, "B")).toBe(false);

      undo();

      expect(target).toEqual({ A: "1", B: "2" });
      expect(Object.hasOwn(target, "C")).toBe(false);
    });

    test("restores keys that existed with undefined value", () => {
      const target: Record<string, string | undefined> = {
        UNDEFINED_KEY: undefined,
      };

      const undo = setWithUndo(target, {
        UNDEFINED_KEY: "set",
      });

      expect(target.UNDEFINED_KEY).toBe("set");

      undo();

      expect(target.UNDEFINED_KEY).toBeUndefined();
      expect(Object.hasOwn(target, "UNDEFINED_KEY")).toBe(true);
    });
  });

  describe("git()", () => {
    test("runs git commands", async () => {
      const result = await git(["--version"]);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("git version");
    });

    test("inherits process.env by default", async () => {
      const restore = setEnvVars({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "test.fromProcessEnv",
        GIT_CONFIG_VALUE_0: "from-process-env",
      });

      try {
        const result = await git(["config", "--get", "test.fromProcessEnv"]);
        expect(result.success).toBe(true);
        expect(result.stdout.trim()).toBe("from-process-env");
      } finally {
        restore();
      }
    });

    test("fullEnv=true does not inherit process.env", async () => {
      const restore = setEnvVars({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "test.fromProcessEnvOnly",
        GIT_CONFIG_VALUE_0: "from-process-env-only",
      });

      try {
        const result = await git(
          ["config", "--get", "test.fromProcessEnvOnly"],
          {
            fullEnv: true,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
            },
          },
        );

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.trim()).toBe("");
      } finally {
        restore();
      }
    });

    test("fullEnv=true uses explicitly provided env", async () => {
      const result = await git(["config", "--get", "test.fromExplicitEnv"], {
        fullEnv: true,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "test.fromExplicitEnv",
          GIT_CONFIG_VALUE_0: "from-explicit-env",
        },
      });

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe("from-explicit-env");
    });
  });

  describe("withLock()", () => {
    test("runs same lock key sequentially", async () => {
      const order: string[] = [];

      const first = withLock("repo-a", async () => {
        order.push("first-start");
        await sleep(30);
        order.push("first-end");
      });

      const second = withLock("repo-a", async () => {
        order.push("second-start");
        await sleep(10);
        order.push("second-end");
      });

      await Promise.all([first, second]);

      expect(order).toEqual([
        "first-start",
        "first-end",
        "second-start",
        "second-end",
      ]);
    });

    test("different lock keys can run in parallel", async () => {
      let active = 0;
      let maxActive = 0;
      const markEnter = () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
      };
      const markLeave = () => {
        active -= 1;
      };

      const task1 = withLock("repo-a", async () => {
        markEnter();
        await sleep(30);
        markLeave();
      });

      const task2 = withLock("repo-b", async () => {
        markEnter();
        await sleep(30);
        markLeave();
      });

      await Promise.all([task1, task2]);

      // If different keys are truly parallel, both critical sections overlap.
      expect(maxActive).toBe(2);
    });
  });

  describe("matchesAnyPattern()", () => {
    test("matches common protected path patterns", () => {
      const patterns = [".github/**", "*.nix", "nix/", "Makefile"];

      expect(matchesAnyPattern(".github/workflows/ci.yml", patterns)).toBe(
        true,
      );
      expect(matchesAnyPattern("flake.nix", patterns)).toBe(true);
      expect(matchesAnyPattern("nix/default.nix", patterns)).toBe(true);
      expect(matchesAnyPattern("Makefile", patterns)).toBe(true);
      expect(matchesAnyPattern("src/index.ts", patterns)).toBe(false);
    });
  });

  describe("branchMatchesPattern()", () => {
    test("supports refs/heads prefix and plain branch names", () => {
      expect(branchMatchesPattern("refs/heads/agent/feat", ["agent/*"])).toBe(
        true,
      );
      expect(branchMatchesPattern("feature/new", ["feature/*"])).toBe(true);
      expect(branchMatchesPattern("main", ["agent/*"])).toBe(false);
    });
  });
});
