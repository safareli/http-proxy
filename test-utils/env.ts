export function omitUndefined(
  values: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

export function setWithUndo(
  target: Record<string, string | undefined>,
  values: Record<string, string | undefined>,
): () => void {
  const previous = Object.assign({}, target);

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }

  return () => {
    for (const key of Object.keys(values)) {
      if (!Object.hasOwn(previous, key)) {
        delete target[key];
        continue;
      }

      target[key] = previous[key];
    }
  };
}

export function setEnvVars(
  values: Record<string, string | undefined>,
): () => void {
  return setWithUndo(process.env, values);
}

export function mergeProcessEnv(
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  return omitUndefined(Object.assign(omitUndefined(process.env), extra ?? {}));
}
