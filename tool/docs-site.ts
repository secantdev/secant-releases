import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliOptions, CommandRequest } from "./adapter.js";
import { CandidateRefusal } from "./candidate.js";

export interface SiteEntry {
  readonly path: string;
  readonly kind: string;
}
export function safeSiteEntries(entries: readonly SiteEntry[]): boolean {
  return (
    entries.length > 0 &&
    new Set(entries.map((entry) => entry.path)).size === entries.length &&
    entries.every(
      ({ path, kind }) =>
        kind === "regular" &&
        /^[A-Za-z0-9_./-]+$/.test(path) &&
        !path.startsWith("/") &&
        !path.split("/").some((part) => part === ".." || part === "") &&
        path !== ".",
    )
  );
}

// Every command has an explicit environment. The deployment token is added only
// to Wrangler; npm retains only the OIDC facts required by trusted publishing.
export function commandEnvironment(environment: NodeJS.ProcessEnv = {}) {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"])
    if (environment[key] !== undefined) base[key] = environment[key];
  return base;
}
export function npmEnvironment(environment: NodeJS.ProcessEnv = {}) {
  const env = commandEnvironment(environment);
  for (const key of [
    "GITHUB_ACTIONS",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_EVENT_NAME",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SERVER_URL",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ])
    if (environment[key] !== undefined) env[key] = environment[key];
  return env;
}

function withArchive<T>(
  bytes: Uint8Array,
  action: (archive: string, root: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), "secant-docs-"));
  try {
    const archive = join(root, "docs-site.tar.gz");
    writeFileSync(archive, bytes);
    return action(archive, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function checked(options: CliOptions, request: CommandRequest): string {
  const result = options.run(request);
  if (result.status !== 0) throw new Error("command-failed", { cause: result });
  return result.stdout;
}
export function listSiteEntries(
  options: CliOptions,
  bytes: Uint8Array,
): readonly SiteEntry[] {
  return withArchive(bytes, (archive) => {
    const env = { ...commandEnvironment(options.environment), LC_ALL: "C" };
    const names = checked(options, {
      command: "tar",
      args: ["-tzf", archive],
      env,
    })
      .trimEnd()
      .split("\n");
    const details = checked(options, {
      command: "tar",
      args: ["-tvzf", archive],
      env,
    })
      .trimEnd()
      .split("\n");
    if (names.length !== details.length)
      throw new CandidateRefusal("unsafe-site-archive");
    return names.map((path, index) => ({
      path,
      kind: details[index]?.startsWith("-") ? "regular" : "other",
    }));
  });
}
export function deploySite(options: CliOptions, bytes: Uint8Array): void {
  const token = options.environment?.CLOUDFLARE_API_TOKEN;
  if (!token) throw new CandidateRefusal("missing-docs-credential");
  withArchive(bytes, (archive, root) => {
    const assets = join(root, "assets");
    mkdirSync(assets);
    checked(options, {
      command: "tar",
      args: ["-xzf", archive, "-C", assets],
      env: commandEnvironment(options.environment),
    });
    const tool = dirname(fileURLToPath(import.meta.url));
    const config = join(root, "wrangler.jsonc");
    writeFileSync(config, readFileSync(join(tool, "wrangler.jsonc")));
    checked(options, {
      command: "node",
      args: [
        join(tool, "docs-deploy/node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        config,
      ],
      env: {
        ...commandEnvironment(options.environment),
        CLOUDFLARE_API_TOKEN: token,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
      },
    });
  });
}
