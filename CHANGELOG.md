# Changelog

What changed in each Secant release, newest first. Each release's notes on GitHub are its section here.

## 0.2.0

The first release published from this repository. Earlier releases are not supported; install this one with the commands in the
[README](https://github.com/secantdev/secant-releases#install).

### New

- A new Home: the Secant wordmark sits centred, a footer shows your current Workspace, and search, commands and the summary of your Runs share one
  command bar.
- Themes: browse and preview themes from Home, and Secant remembers your choice. Without a saved theme, Secant uses Catppuccin.
- Choose the model and effort before a Run starts, change them while it runs, and Secant remembers your last choice for each coding agent.
- Talk to an agent while it works: press Enter to send it a message. Interrupt stops only the current turn and keeps your unsent message.
- Questions from Claude Code and Codex appear in a panel you can answer from the terminal app or from headless commands, and stay open across turns.
- Mention files from your Workspace with fuzzy matching, and run app commands from the input box.
- Run history keeps tool calls, command output, file changes and thinking summaries, opened on demand, and long Runs scroll smoothly.
- When a Run stops, Secant says why: a command could not start, timed out or was killed, required output was missing, an agent turn failed, or
  Secant was shut down.
- The Matt Front Spec workflow lets the agent mark a step done, waits at a review checkpoint, and starts ticket planning in a fresh session.

### Changed

- Install with one command from secant.sh. Releases now come from this repository.
- Claude Code turns run in auto mode, and Codex runs under Auto-review. Secant now requires Codex 0.159.0 or newer.
- Long lines wrap instead of being cut off. Set `SECANT_REDUCED_MOTION=1` to turn off the animated working indicator.
- Each launch writes a log to the Secant home folder, a crash message names it, and logs older than 30 days are removed.
- On Windows, the processes an agent starts are cleaned up whenever a Run stops.
