import { CandidateRefusal, digest, validateCandidate } from "./candidate.js";

export type StageRequest =
  | {
      readonly kind: "version";
      readonly version: string;
      readonly changelog: string;
    }
  | { readonly kind: "rehearsal"; readonly runId: number };
export interface PrivateRun {
  readonly id: number;
  readonly event: string;
  readonly branch: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly commit: string;
  readonly workflow: string;
  readonly jobs: readonly {
    readonly name: string;
    readonly conclusion: string | null;
  }[];
  readonly artifacts: readonly string[];
}
export interface ReleaseState {
  readonly draft: boolean;
  readonly assets: ReadonlyMap<string, Uint8Array>;
}
export interface PublishPort {
  findRun(request: StageRequest): Promise<PrivateRun | undefined>;
  readCandidate(run: PrivateRun): Promise<ReadonlyMap<string, Uint8Array>>;
  readRelease(tag: string): Promise<ReleaseState | undefined>;
  createDraft(tag: string, notes: string): Promise<void>;
  uploadAsset(tag: string, name: string, bytes: Uint8Array): Promise<void>;
  deleteDraft(tag: string): Promise<void>;
  inspectPackage(
    name: string,
    version: string,
    sha256: string,
  ): Promise<"missing" | "identical" | "conflicting">;
}
export type StageOutcome =
  | {
      readonly kind: "done";
      readonly tag: string;
      readonly assets: readonly {
        readonly name: string;
        readonly size: number;
        readonly sha256: string;
      }[];
      readonly summary: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly cause?: unknown;
    };
export function admittedRun(request: StageRequest, run: PrivateRun): boolean {
  if (
    run.workflow !== ".github/workflows/check.yml" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    return false;
  if (
    request.kind === "version"
      ? run.event !== "push" || run.branch !== `v${request.version}`
      : run.event !== "workflow_dispatch" || run.id !== request.runId
  )
    return false;
  const required = [
    "build",
    ...["check", "consumer"].flatMap((job) =>
      ["ubuntu-latest", "windows-latest", "macos-latest"].map(
        (os) => `${job} (${os})`,
      ),
    ),
    ...(request.kind === "version" ? ["release-approval"] : []),
  ];
  return (
    required.every(
      (name) =>
        run.jobs.filter(
          (job) =>
            (job.name === name ||
              (name.startsWith("consumer (") &&
                job.name.startsWith(name.slice(0, -1) + ", "))) &&
            job.conclusion === "success",
        ).length === 1,
    ) &&
    ["release-archives", "platform-packages"].every((name) =>
      run.artifacts.includes(name),
    )
  );
}

function changelogNotes(
  version: string,
  changelog: string,
): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const indices = lines.flatMap((line, index) =>
    line === `## ${version}` ? [index] : [],
  );
  if (indices.length !== 1) return undefined;
  const start = indices[0]! + 1;
  const next = lines.findIndex(
    (line, index) => index >= start && /^## /.test(line),
  );
  return (
    lines
      .slice(start, next < 0 ? undefined : next)
      .join("\n")
      .trim() || undefined
  );
}

export async function readStageDraft(request: StageRequest, port: PublishPort) {
  const tag =
    request.kind === "version"
      ? `v${request.version}`
      : `rehearsal-run-${request.runId}`;
  const release = await port.readRelease(tag);
  if (!release) return { kind: "missing" as const, tag };
  if (!release.draft) throw new CandidateRefusal("visible-release");
  try {
    const candidate = validateCandidate(release.assets, {
      version: request.kind === "version" ? request.version : undefined,
    });
    return { kind: "complete" as const, tag, candidate };
  } catch (cause) {
    if (cause instanceof CandidateRefusal && cause.message === "missing-file")
      return { kind: "partial" as const, tag, release };
    throw cause;
  }
}
function stagedOutcome(
  tag: string,
  candidate: ReturnType<typeof validateCandidate>,
): StageOutcome {
  return {
    kind: "done",
    tag,
    summary: candidate.summary,
    assets: [...candidate.assets].map(([name, bytes]) => ({
      name,
      size: bytes.byteLength,
      sha256: digest(bytes),
    })),
  };
}

export async function stage(
  request: StageRequest,
  port: PublishPort,
): Promise<StageOutcome> {
  try {
    if (
      request.kind === "version"
        ? !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(request.version)
        : !Number.isSafeInteger(request.runId) || request.runId <= 0
    )
      return { kind: "refused", reason: "invalid-request" };
    const notes =
      request.kind === "version"
        ? changelogNotes(request.version, request.changelog)
        : "";
    if (notes === undefined)
      return { kind: "refused", reason: "missing-changelog" };
    const draft = await readStageDraft(request, port);
    if (draft.kind === "complete") {
      if (request.kind === "rehearsal") await port.deleteDraft(draft.tag);
      return stagedOutcome(draft.tag, draft.candidate);
    }
    const run = await port.findRun(request);
    if (!run) return { kind: "refused", reason: "missing-run" };
    if (!admittedRun(request, run))
      return { kind: "refused", reason: "invalid-run" };
    const candidate = validateCandidate(await port.readCandidate(run), {
      run: { id: run.id, commit: run.commit },
      version: request.kind === "version" ? request.version : undefined,
    });
    if (
      run.artifacts.includes("approval-summary") &&
      !candidate.assets.has("approval-summary.json")
    )
      return { kind: "refused", reason: "missing-summary" };
    const tag = draft.tag;
    const release = draft.kind === "partial" ? draft.release : undefined;
    if (release) {
      for (const [name, bytes] of release.assets) {
        const approved = candidate.assets.get(name);
        if (!approved || digest(bytes) !== digest(approved))
          return { kind: "refused", reason: "asset-conflict" };
      }
    } else await port.createDraft(tag, notes);
    // The approved candidate manifest is the final completion marker. An
    // interrupted upload, including the optional summary, stays visibly partial.
    const uploads = [...candidate.assets].sort(
      ([left], [right]) =>
        Number(left === "candidate-manifest.json") -
        Number(right === "candidate-manifest.json"),
    );
    for (const [name, bytes] of uploads)
      if (!release?.assets.has(name)) await port.uploadAsset(tag, name, bytes);
    // Read back every write; done means the store contains the complete candidate.
    const staged = await port.readRelease(tag);
    if (
      !staged?.draft ||
      staged.assets.size !== candidate.assets.size ||
      [...candidate.assets].some(
        ([name, bytes]) =>
          digest(staged.assets.get(name) ?? new Uint8Array()) !== digest(bytes),
      )
    )
      return { kind: "refused", reason: "incomplete-draft" };
    if (request.kind === "rehearsal") await port.deleteDraft(tag);
    return stagedOutcome(tag, candidate);
  } catch (cause) {
    return cause instanceof CandidateRefusal
      ? {
          kind: "refused",
          reason: cause.message,
          ...(cause.cause === undefined ? {} : { cause: cause.cause }),
        }
      : { kind: "refused", reason: "external-failure", cause };
  }
}
