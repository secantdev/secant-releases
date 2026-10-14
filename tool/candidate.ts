import { createHash } from "node:crypto";

// This frozen ingress contract is repeated here deliberately: the public tool must
// not import the private candidate producers or depend on a runtime package.
const identities = [
  {
    key: "windows-x64",
    os: "windows",
    npmOs: "win32",
    cpu: "x64",
    package: "@secantdev/secant-windows-x64",
    archive: "secant-windows-x64.zip",
    archiveType: "zip",
    executable: "secant.exe",
  },
  {
    key: "darwin-arm64",
    os: "macos",
    npmOs: "darwin",
    cpu: "arm64",
    package: "@secantdev/secant-darwin-arm64",
    archive: "secant-darwin-arm64.zip",
    archiveType: "zip",
    executable: "secant",
  },
  {
    key: "linux-x64",
    os: "linux",
    npmOs: "linux",
    cpu: "x64",
    package: "@secantdev/secant-linux-x64",
    archive: "secant-linux-x64.tar.gz",
    archiveType: "tar.gz",
    executable: "secant",
  },
] as const;

export class CandidateRefusal extends Error {}
function requireFact(ok: boolean, reason = "invalid-manifest"): asserts ok {
  if (!ok) throw new CandidateRefusal(reason);
}
export function record(value: unknown): Record<string, unknown> {
  requireFact(
    typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
export function filename(value: unknown): string {
  requireFact(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
  );
  return value;
}
export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hash(value: unknown): string {
  requireFact(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
  return value;
}
function list(value: unknown): Record<string, unknown>[] {
  requireFact(Array.isArray(value));
  return value.map(record);
}
function json(bytes: Uint8Array | undefined): Record<string, unknown> {
  requireFact(bytes !== undefined, "missing-file");
  try {
    return record(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (cause) {
    throw new CandidateRefusal("invalid-manifest", { cause });
  }
}
export function validateCandidate(
  files: ReadonlyMap<string, Uint8Array>,
  facts: {
    readonly version?: string;
    readonly run?: { readonly id: number; readonly commit: string };
  },
) {
  const manifest = json(files.get("candidate-manifest.json"));
  requireFact(
    typeof manifest.version === "string" &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version),
  );
  requireFact(
    facts.version === undefined || facts.version === manifest.version,
    "version-mismatch",
  );
  hash(manifest.licenseSha256);
  hash(manifest.noticesSha256);
  const targets = list(manifest.targets);
  const packages = json(files.get("package-manifest.json"));
  const launcher = json(files.get("launcher-manifest.json"));
  for (const other of [packages, launcher]) {
    requireFact(other.version === manifest.version, "version-mismatch");
    requireFact(
      other.licenseSha256 === manifest.licenseSha256 &&
        other.noticesSha256 === manifest.noticesSha256,
      "legal-mismatch",
    );
  }
  const packed = list(packages.packages);
  requireFact(
    targets.length === identities.length && packed.length === identities.length,
    "identity-mismatch",
  );
  const approved = new Map<string, Uint8Array>();
  const add = (name: string, expected?: unknown) => {
    requireFact(!approved.has(name), "duplicate-file");
    const bytes = files.get(name);
    requireFact(bytes !== undefined, "missing-file");
    if (expected !== undefined)
      requireFact(digest(bytes) === hash(expected), "digest-mismatch");
    approved.set(name, bytes);
  };
  const expectedPlatforms: Record<
    string,
    { package: string; executable: string }
  > = {};
  const checksums: string[] = [];
  for (const [index, identity] of identities.entries()) {
    const target = targets[index];
    const pkg = packed[index];
    requireFact(target !== undefined && pkg !== undefined, "identity-mismatch");
    for (const key of [
      "key",
      "os",
      "cpu",
      "package",
      "archive",
      "archiveType",
      "executable",
    ] as const)
      requireFact(target[key] === identity[key], "identity-mismatch");
    for (const key of ["key", "cpu", "package", "executable"] as const)
      requireFact(pkg[key] === identity[key], "identity-mismatch");
    requireFact(
      pkg.os === identity.npmOs &&
        pkg.binarySha256 === hash(target.binarySha256),
      "binary-mismatch",
    );
    add(identity.archive, target.archiveSha256);
    add(filename(pkg.tarball), pkg.tarballSha256);
    checksums.push(`${hash(target.archiveSha256)}  ${identity.archive}`);
    expectedPlatforms[`${identity.npmOs}-${identity.cpu}`] = {
      package: identity.package,
      executable: identity.executable,
    };
  }
  requireFact(launcher.package === "@secantdev/secant", "identity-mismatch");
  const platforms = record(launcher.platforms);
  requireFact(
    Object.keys(platforms).length === identities.length,
    "identity-mismatch",
  );
  for (const [key, expected] of Object.entries(expectedPlatforms)) {
    const platform = record(platforms[key]);
    requireFact(
      platform.package === expected.package &&
        platform.executable === expected.executable,
      "identity-mismatch",
    );
  }
  add(filename(launcher.tarball), launcher.tarballSha256);
  add("SHA256SUMS");
  requireFact(
    Buffer.from(approved.get("SHA256SUMS")!)
      .toString("utf8")
      .replace(/\r\n/g, "\n") ===
      checksums.join("\n") + "\n",
    "checksum-mismatch",
  );
  for (const name of [
    "candidate-manifest.json",
    "package-manifest.json",
    "launcher-manifest.json",
  ])
    add(name);
  let summary = "";
  if (files.has("approval-summary.json")) {
    summary = approvalSummary(
      files.get("approval-summary.json"),
      facts,
      approved,
    );
    add("approval-summary.json");
  }
  requireFact(files.size === approved.size, "unexpected-file");
  return { version: manifest.version, assets: approved, summary };
}

// Never render downloaded Markdown or arbitrary producer output in public logs.
// Only this allowlisted JSON contract can become the public approval summary.
function approvalSummary(
  bytes: Uint8Array | undefined,
  facts: { readonly run?: { readonly id: number; readonly commit: string } },
  approved: ReadonlyMap<string, Uint8Array>,
): string {
  const value = json(bytes);
  requireFact(
    Object.keys(value).every((key) =>
      [
        "repository",
        "runId",
        "commit",
        "checklist",
        "artifacts",
        "bundleDigests",
      ].includes(key),
    ),
    "unsafe-summary",
  );
  requireFact(
    value.repository === "secantdev/secant" &&
      Number.isSafeInteger(value.runId) &&
      typeof value.runId === "number" &&
      value.runId > 0,
    "unsafe-summary",
  );
  requireFact(
    typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit),
    "unsafe-summary",
  );
  requireFact(value.checklist === "secant-release-checklist", "unsafe-summary");
  requireFact(
    facts.run === undefined ||
      (value.runId === facts.run.id && value.commit === facts.run.commit),
    "summary-mismatch",
  );
  const artifacts = list(value.artifacts).map((artifact) => {
    requireFact(
      Object.keys(artifact).every((key) =>
        ["name", "size", "sha256"].includes(key),
      ),
      "unsafe-summary",
    );
    requireFact(
      Number.isSafeInteger(artifact.size) &&
        typeof artifact.size === "number" &&
        artifact.size >= 0,
      "unsafe-summary",
    );
    const name = filename(artifact.name);
    const bytes = approved.get(name);
    requireFact(
      bytes !== undefined &&
        bytes.byteLength === artifact.size &&
        digest(bytes) === hash(artifact.sha256),
      "summary-mismatch",
    );
    return `${name} ${artifact.size} ${artifact.sha256}`;
  });
  requireFact(Array.isArray(value.bundleDigests), "unsafe-summary");
  return (
    [
      value.repository,
      String(value.runId),
      value.commit,
      value.checklist,
      ...artifacts,
      ...value.bundleDigests.map(hash),
    ].join("\n") + "\n"
  );
}
