import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateRefusal, digest, filename, record } from "./candidate.js";
import type { PrivateRun, PublishPort, StageRequest } from "./publish.js";

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly token: string;
}
export type CommandRunner = (request: CommandRequest) => {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};
export interface CliOptions {
  readonly run: CommandRunner;
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly selectedRunId?: number;
  readonly privateToken: string;
  readonly publicToken: string;
  readonly candidateDir: string;
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new CandidateRefusal("invalid-remote-facts");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new CandidateRefusal("invalid-remote-facts");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new CandidateRefusal("invalid-remote-facts");
  return value;
}
function conclusion(value: unknown): string | null {
  return value === null ? null : string(value);
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new CandidateRefusal("invalid-remote-facts", { cause });
  }
}
function command(options: CliOptions, repo: string, args: readonly string[]) {
  return options.run({
    command: "gh",
    args: [...args, "--repo", repo],
    token:
      repo === "secantdev/secant" ? options.privateToken : options.publicToken,
  });
}
function checked(
  options: CliOptions,
  repo: string,
  args: readonly string[],
): string {
  const result = command(options, repo, args);
  if (result.status !== 0) throw new Error("command-failed", { cause: result });
  return result.stdout;
}

// gh api has no --repo flag. Read only artifact metadata through the runtime HTTP
// builtin, with a literal repository endpoint and the private Actions-read token.
async function artifacts(
  options: CliOptions,
  runId: number,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const response = await options.fetch(
      `https://api.github.com/repos/secantdev/secant/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${options.privateToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error("artifact-metadata-failed", { cause: response.status });
    const value = record(await response.json());
    const entries = array(value.artifacts);
    for (const entry of entries) {
      const artifact = record(entry);
      if (typeof artifact.expired !== "boolean")
        throw new CandidateRefusal("invalid-remote-facts");
      if (!artifact.expired) names.push(string(artifact.name));
    }
    if (entries.length < 100) return names;
  }
}

async function findRun(
  options: CliOptions,
  request: StageRequest,
): Promise<PrivateRun | undefined> {
  const workflows = array(
    parseJson(
      checked(options, "secantdev/secant", [
        "workflow",
        "list",
        "--all",
        "--limit",
        "1000",
        "--json",
        "id,path",
      ]),
    ),
  );
  const workflow = workflows
    .map(record)
    .find((item) => item.path === ".github/workflows/check.yml");
  if (!workflow) return undefined;
  const workflowId = integer(workflow.id);
  let id: number;
  if (options.selectedRunId !== undefined) id = options.selectedRunId;
  else if (request.kind === "rehearsal") id = request.runId;
  else {
    const runs = array(
      parseJson(
        checked(options, "secantdev/secant", [
          "run",
          "list",
          "--workflow",
          "check.yml",
          "--branch",
          `v${request.version}`,
          "--event",
          "push",
          "--limit",
          "1",
          "--json",
          "databaseId",
        ]),
      ),
    );
    if (runs.length === 0) return undefined;
    id = integer(record(runs[0]).databaseId);
  }
  const result = command(options, "secantdev/secant", [
    "run",
    "view",
    String(id),
    "--json",
    "databaseId,event,headBranch,status,conclusion,headSha,workflowDatabaseId,jobs",
  ]);
  if (result.status !== 0) {
    if (/HTTP 404/i.test(result.stderr)) return undefined;
    throw new Error("command-failed", { cause: result });
  }
  const value = record(parseJson(result.stdout));
  if (
    integer(value.databaseId) !== id ||
    integer(value.workflowDatabaseId) !== workflowId
  )
    throw new CandidateRefusal("invalid-remote-facts");
  const commit = string(value.headSha);
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new CandidateRefusal("invalid-remote-facts");
  return {
    id,
    commit,
    workflow: ".github/workflows/check.yml",
    event: string(value.event),
    branch: string(value.headBranch),
    status: string(value.status),
    conclusion: conclusion(value.conclusion),
    jobs: array(value.jobs).map((entry) => {
      const job = record(entry);
      return { name: string(job.name), conclusion: conclusion(job.conclusion) };
    }),
    artifacts: await artifacts(options, id),
  };
}
function localFiles(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (!lstatSync(path).isFile())
      throw new CandidateRefusal("unexpected-file");
    files.set(filename(entry), readFileSync(path));
  }
  return files;
}

export function createCliPort(options: CliOptions): PublishPort {
  return {
    findRun: (request) => findRun(options, request),
    async readCandidate(run) {
      const files = new Map<string, Uint8Array>();
      for (const artifact of [
        "release-archives",
        "platform-packages",
        ...(run.artifacts.includes("approval-summary")
          ? ["approval-summary"]
          : []),
      ]) {
        for (const [name, bytes] of localFiles(
          join(options.candidateDir, artifact),
        )) {
          if (files.has(name)) throw new CandidateRefusal("duplicate-file");
          files.set(name, bytes);
        }
      }
      return files;
    },
    async readRelease(tag) {
      const result = command(options, "secantdev/secant-releases", [
        "release",
        "view",
        tag,
        "--json",
        "isDraft,assets",
      ]);
      if (result.status !== 0) {
        if (/release not found|HTTP 404/i.test(result.stderr)) return undefined;
        throw new Error("command-failed", { cause: result });
      }
      const value = record(parseJson(result.stdout));
      if (typeof value.isDraft !== "boolean")
        throw new CandidateRefusal("invalid-remote-facts");
      const names = array(value.assets).map((entry) =>
        filename(record(entry).name),
      );
      if (new Set(names).size !== names.length)
        throw new CandidateRefusal("duplicate-file");
      const assets = new Map<string, Uint8Array>();
      const dir = mkdtempSync(join(tmpdir(), "secant-draft-"));
      try {
        for (const name of names) {
          checked(options, "secantdev/secant-releases", [
            "release",
            "download",
            tag,
            "--pattern",
            name,
            "--dir",
            dir,
          ]);
          assets.set(name, readFileSync(join(dir, name)));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return { draft: value.isDraft, assets };
    },
    async createDraft(tag, notes) {
      const dir = mkdtempSync(join(tmpdir(), "secant-notes-"));
      try {
        const path = join(dir, "notes.md");
        writeFileSync(path, notes);
        checked(options, "secantdev/secant-releases", [
          "release",
          "create",
          tag,
          "--draft",
          "--target",
          "main",
          "--title",
          tag,
          "--notes-file",
          path,
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async uploadAsset(tag, name, bytes) {
      const dir = mkdtempSync(join(tmpdir(), "secant-upload-"));
      try {
        const path = join(dir, filename(name));
        writeFileSync(path, bytes);
        checked(options, "secantdev/secant-releases", [
          "release",
          "upload",
          tag,
          path,
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async deleteDraft(tag) {
      checked(options, "secantdev/secant-releases", [
        "release",
        "delete",
        tag,
        "--yes",
      ]);
    },
    async inspectPackage(name, version, sha256) {
      const result = await options.fetch(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (result.status === 404) return "missing";
      if (!result.ok)
        throw new Error("registry-read-failed", { cause: result.status });
      const value = record(await result.json());
      const url = new URL(string(record(value.dist).tarball));
      if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org")
        throw new CandidateRefusal("invalid-remote-facts");
      const tarball = await options.fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!tarball.ok)
        throw new Error("registry-read-failed", { cause: tarball.status });
      return digest(new Uint8Array(await tarball.arrayBuffer())) === sha256
        ? "identical"
        : "conflicting";
    },
  };
}
