# Secant

Secant is a terminal app that helps you plan and build software with a coding agent. You pick a workflow, pick Claude Code or Codex, and Secant
runs the workflow step by step in your project, asking you when it needs a decision. The included **Matt Front Spec** workflow turns an idea into a
spec and tickets, then helps you work through the tickets one at a time.

## Install

Mac or Linux:

```sh
curl -fsSL https://secant.sh/install | sh
```

Windows (PowerShell):

```powershell
irm https://secant.sh/install.ps1 | iex
```

The installer downloads the latest release from this repository, checks it against the release's checksums, and puts `secant` in `~/.secant/bin`.
Run the same command again to update.

You can also install with npm (`npm install -g @secantdev/secant`) or download an archive from the
[latest release](https://github.com/secantdev/secant-releases/releases/latest).

## Supported platforms

- Windows x64
- macOS arm64
- Linux x64

Only the latest release is supported.

## Get started

First install and sign in to Claude Code, or to Codex 0.159.0 or newer. Then open a terminal in the project you want to work on and run:

```sh
secant
```

Approve the folder, choose **Start a Run** → **Matt Front Spec**, pick your coding agent, and describe your idea. Run `secant --help` to see the
other commands.

## What changed

Each release's notes are in the [CHANGELOG](./CHANGELOG.md).

## Licence

Secant is free to use, including at work. You may not redistribute, modify, decompile or reverse engineer it. Secant is provided "as is", without
warranty of any kind. The full terms are in [LICENSE.md](./LICENSE.md) and inside every release. The installer scripts in this repository are MIT
licensed.

The included workflow's skills come from Matt Pocock's [skills](https://github.com/mattpocock/skills), MIT licensed.

## Get help

See [SUPPORT](./SUPPORT.md) for where to ask, how to report a security problem, and what to include.
