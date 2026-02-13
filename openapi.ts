import { parse as parseYaml } from "yaml";

const CACHE_DIR = "./.openapi-cache";

interface PathSegment {
  value: string;
  isParameter: boolean;
}

interface OpenApiPath {
  template: string;
  segments: PathSegment[];
  methods: string[];
}

export interface PatternOption {
  pattern: string;
  description: string;
}

export interface OpenApiSpecConfig {
  url?: string;
  path?: string;
}

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
}

// In-memory cache of parsed OpenAPI specs per host
const specCache = new Map<string, OpenApiPath[]>();

function parsePathTemplate(template: string): PathSegment[] {
  return template
    .split("/")
    .filter((s) => s.length > 0)
    .map((segment) => ({
      value: segment,
      isParameter: segment.startsWith("{") && segment.endsWith("}"),
    }));
}

function parseOpenApiPaths(spec: OpenApiSpec): OpenApiPath[] {
  const paths: OpenApiPath[] = [];

  for (const [template, pathItem] of Object.entries(spec.paths)) {
    const methods = Object.keys(pathItem)
      .filter((m) =>
        ["get", "post", "put", "patch", "delete", "head", "options"].includes(
          m.toLowerCase(),
        ),
      )
      .map((m) => m.toUpperCase());

    if (methods.length > 0) {
      paths.push({
        template,
        segments: parsePathTemplate(template),
        methods,
      });
    }
  }

  return paths;
}

function parseSpecContent(content: string, sourcePath: string): OpenApiSpec {
  // Determine format from content or file extension
  const trimmed = content.trim();
  const isJson = trimmed.startsWith("{") || sourcePath.endsWith(".json");

  if (isJson) {
    return JSON.parse(content) as OpenApiSpec;
  }
  return parseYaml(content) as OpenApiSpec;
}

function getCacheFileName(host: string, sourceUrl: string): string {
  // Preserve extension from source URL if present
  if (sourceUrl.endsWith(".json")) {
    return `${host}.json`;
  }
  return `${host}.yaml`;
}

export async function loadOpenApiSpec(
  host: string,
  config: OpenApiSpecConfig,
): Promise<void> {
  let specContent: string;
  let sourcePath: string;

  if (config.path) {
    const file = Bun.file(config.path);
    if (!(await file.exists())) {
      console.warn(`OpenAPI spec file not found: ${config.path}`);
      return;
    }
    specContent = await file.text();
    sourcePath = config.path;
  } else if (config.url) {
    // Check cache first
    await Bun.write(`${CACHE_DIR}/.gitkeep`, "");
    const cacheFileName = getCacheFileName(host, config.url);
    const cacheFile = Bun.file(`${CACHE_DIR}/${cacheFileName}`);

    if (await cacheFile.exists()) {
      console.log(`Loading cached OpenAPI spec for ${host}`);
      specContent = await cacheFile.text();
      sourcePath = cacheFileName;
    } else {
      console.log(`Downloading OpenAPI spec for ${host} from ${config.url}`);
      try {
        const response = await fetch(config.url);
        if (!response.ok) {
          console.warn(
            `Failed to download OpenAPI spec: ${response.status} ${response.statusText}`,
          );
          return;
        }
        specContent = await response.text();
        await Bun.write(`${CACHE_DIR}/${cacheFileName}`, specContent);
        console.log(`Cached OpenAPI spec for ${host}`);
        sourcePath = config.url;
      } catch (error) {
        console.warn(`Failed to download OpenAPI spec: ${error}`);
        return;
      }
    }
  } else {
    console.warn(`No OpenAPI spec URL or path configured for ${host}`);
    return;
  }

  try {
    const spec = parseSpecContent(specContent, sourcePath);
    const paths = parseOpenApiPaths(spec);
    specCache.set(host, paths);
    console.log(`Loaded ${paths.length} API paths for ${host}`);
  } catch (error) {
    console.warn(`Failed to parse OpenAPI spec for ${host}: ${error}`);
  }
}

export function matchPathToTemplate(
  host: string,
  method: string,
  path: string,
): OpenApiPath | null {
  const paths = specCache.get(host);
  if (!paths) {
    return null;
  }

  const pathWithoutQuery = path.split("?")[0] ?? path;
  const actualSegments = pathWithoutQuery
    .split("/")
    .filter((s) => s.length > 0);
  const upperMethod = method.toUpperCase();

  for (const apiPath of paths) {
    if (!apiPath.methods.includes(upperMethod)) {
      continue;
    }

    if (apiPath.segments.length !== actualSegments.length) {
      continue;
    }

    let matches = true;
    for (let i = 0; i < apiPath.segments.length; i++) {
      const templateSeg = apiPath.segments[i]!;
      const actualSeg = actualSegments[i];

      if (!templateSeg.isParameter && templateSeg.value !== actualSeg) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return apiPath;
    }
  }

  return null;
}

export function generatePatternOptions(
  method: string,
  actualPath: string,
  template: OpenApiPath | null,
): PatternOption[] {
  const pathWithoutQuery = actualPath.split("?")[0] ?? actualPath;
  const options: PatternOption[] = [];

  // Always start with exact path
  options.push({
    pattern: `${method} ${pathWithoutQuery}`,
    description: `${method} ${pathWithoutQuery}`,
  });

  if (template) {
    const actualSegments = pathWithoutQuery
      .split("/")
      .filter((s) => s.length > 0);

    // Find parameter positions (indices in the segments array)
    const paramPositions: number[] = [];
    for (let i = 0; i < template.segments.length; i++) {
      if (template.segments[i]!.isParameter) {
        paramPositions.push(i);
      }
    }

    // Generate patterns by progressively wildcarding from right to left
    const usedPatterns = new Set<string>();
    usedPatterns.add(`${method} ${pathWithoutQuery}`);

    for (let i = paramPositions.length - 1; i >= 0; i--) {
      // Create pattern with positions [i..end] wildcarded
      const positionsToWildcard = paramPositions.slice(i);
      const patternSegments = [...actualSegments];

      for (const pos of positionsToWildcard) {
        patternSegments[pos] = "*";
      }

      const patternPath = "/" + patternSegments.join("/");
      const pattern = `${method} ${patternPath}`;

      if (usedPatterns.has(pattern)) {
        continue;
      }
      usedPatterns.add(pattern);

      options.push({
        pattern,
        description: pattern,
      });
    }
  }

  // Always add "all METHOD requests" as final option
  options.push({
    pattern: `${method} *`,
    description: `${method} *`,
  });

  return options;
}
