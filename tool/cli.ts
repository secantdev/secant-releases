#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  createCliPort,
  type CommandRunner,
  type CliOptions,
} from "./adapter.js";
import {
  admittedRun,
  readStageDraft,
  stage,
  release,
  type StageRequest,
} from "./publish.js";

export async function runPublishCli(options: {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly run: CommandRunner;
  readonly fetch: CliOptions["fetch"];
  readonly write: (text: string) => void;
  readonly readChangelog?: () => string;
}): Promise<number> {
  try {
    const mode = options.args[0];
    const env = options.environment;
    if (
      options.args.length !== 1 ||
      (mode !== "discover" && mode !== "stage" && mode !== "release")
    )
      throw new Error("invalid-request");
    if (
      mode === "release" &&
      (env.GITHUB_ACTIONS !== "true" ||
        env.GITHUB_REPOSITORY !== "secantdev/secant-releases" ||
        env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
        env.GITHUB_REF !== "refs/heads/main" ||
        env.GITHUB_WORKFLOW_REF !==
          "secantdev/secant-releases/.github/workflows/publish.yml@refs/heads/main" ||
        !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
        !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
        env.NODE_AUTH_TOKEN)
    )
      throw new Error("invalid-publication-context");
    const version = env.SECANT_VERSION ?? "";
    const manual = env.SECANT_MANUAL_RUN_ID ?? "";
    if (
      version.length > 0 === manual.length > 0 ||
      (version &&
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) ||
      (manual && !/^[1-9]\d*$/.test(manual))
    )
      throw new Error("invalid-request");
    const request: StageRequest = version
      ? {
          kind: "version",
          version,
          changelog:
            mode !== "discover"
              ? (
                  options.readChangelog ??
                  (() => readFileSync("CHANGELOG.md", "utf8"))
                )()
              : "",
        }
      : { kind: "rehearsal", runId: Number(manual) };
    if (request.kind === "rehearsal" && !Number.isSafeInteger(request.runId))
      throw new Error("invalid-request");
    const privateToken = env.SECANT_PRIVATE_TOKEN;
    const publicToken = env.GH_TOKEN;
    if (
      (!privateToken && mode !== "release") ||
      !publicToken ||
      (mode === "release" && !env.CLOUDFLARE_API_TOKEN)
    )
      throw new Error("missing-credential");
    if (mode === "release" && (request.kind !== "version" || privateToken))
      throw new Error("invalid-request");
    const selected = env.SECANT_SELECTED_RUN_ID;
    if (
      selected &&
      (!/^[1-9]\d*$/.test(selected) || !Number.isSafeInteger(Number(selected)))
    )
      throw new Error("invalid-request");
    const port = createCliPort({
      environment: env,
      selectedRunId: selected ? Number(selected) : undefined,
      run: options.run,
      fetch: options.fetch,
      privateToken,
      publicToken,
      candidateDir: env.SECANT_CANDIDATE_DIR ?? "candidate",
    });
    if (mode === "release") {
      if (request.kind !== "version") throw new Error("invalid-request");
      const result = await release(request, port);
      if (result.kind === "refused") {
        options.write(`Publish refused: ${result.reason}\n`);
        return 1;
      }
      return 0;
    }
    if (mode === "discover") {
      const draft = await readStageDraft(request, port);
      if (draft.kind === "complete") {
        if (!env.GITHUB_OUTPUT) throw new Error("missing-output");
        appendFileSync(env.GITHUB_OUTPUT, "resume=true\n");
        return 0;
      }
      const facts = await port.findRun(request);
      if (!facts || !admittedRun(request, facts)) {
        options.write("Publish refused: invalid-run\n");
        return 1;
      }
      if (!env.GITHUB_OUTPUT) throw new Error("missing-output");
      appendFileSync(
        env.GITHUB_OUTPUT,
        `resume=false\nrun-id=${facts.id}\nsummary-artifact=${facts.artifacts.includes("approval-summary")}\n`,
      );
      options.write(`secantdev/secant ${facts.id} ${facts.commit}\n`);
      return 0;
    }
    const result = await stage(request, port);
    if (result.kind === "refused") {
      options.write(`Publish refused: ${result.reason}\n`);
      return 1;
    }
    for (const asset of result.assets)
      options.write(`${asset.name} ${asset.size} ${asset.sha256}\n`);
    if (result.summary && env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, result.summary);
    return 0;
  } catch {
    options.write("Publish refused: external-failure\n");
    return 1;
  }
}
if (import.meta.main) {
  process.exitCode = await runPublishCli({
    args: process.argv.slice(2),
    environment: process.env,
    fetch,
    write: (text) => process.stdout.write(text),
    run: (request) => {
      const result = spawnSync(request.command, [...request.args], {
        env: request.env,
        encoding: "utf8",
        timeout: request.command === "node" ? 300_000 : 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  });
}
