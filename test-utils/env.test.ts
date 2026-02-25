import { describe, expect, test } from "bun:test";
import { mergeProcessEnv, setEnvVars, setWithUndo } from "./env";

describe("test-utils/env.ts", () => {
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

  describe("setEnvVars()", () => {
    test("temporarily sets process env vars and restores after undo", () => {
      const oldValue = process.env["HTTP_PROXY_TEST_ENV"];
      const restore = setEnvVars({ HTTP_PROXY_TEST_ENV: "temporary-value" });

      try {
        expect(process.env["HTTP_PROXY_TEST_ENV"]).toBe("temporary-value");
      } finally {
        restore();
      }

      expect(process.env["HTTP_PROXY_TEST_ENV"]).toBe(oldValue);
    });
  });

  describe("mergeProcessEnv()", () => {
    test("copies process.env and applies overrides", () => {
      const restore = setEnvVars({ HTTP_PROXY_MERGE_TEST: "base" });
      try {
        const merged = mergeProcessEnv({ HTTP_PROXY_MERGE_TEST: "override" });
        expect(merged["HTTP_PROXY_MERGE_TEST"]).toBe("override");
      } finally {
        restore();
      }
    });

    test("removes keys when override is undefined", () => {
      const restore = setEnvVars({ HTTP_PROXY_MERGE_REMOVE_TEST: "value" });
      try {
        const merged = mergeProcessEnv({ HTTP_PROXY_MERGE_REMOVE_TEST: undefined });
        expect(Object.hasOwn(merged, "HTTP_PROXY_MERGE_REMOVE_TEST")).toBe(false);
      } finally {
        restore();
      }
    });
  });
});
