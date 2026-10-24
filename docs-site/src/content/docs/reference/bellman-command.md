---
title: The bellman command
description: bellman update, bellman doctor, bellman feature-request and bellman version, from the npm package.
---

`bellman` is a command you run in a terminal. It is not one of the tools your agent calls. It updates the npm package, says what Claude Code on your machine runs of Bellman, opens the feature-request form on GitHub, and prints the installed version.

The npm package, `@bellman-sh/mcp-server`, puts `bellman` on your PATH, and the installer at `https://bellman.sh/install.sh` installs that package. The Claude Code plugin does not, so a machine with only the plugin has no `bellman` command. To take the plugin's next release, run `claude plugin update bellman@bellman`.

## Usage

```text
Usage: bellman <command>

  feature-request [words...]  open the feature-request form on GitHub; the words become its title
  update [--check]            install the latest release from npm; --check only reports
  doctor                      say what Claude Code here runs of Bellman, and how to fix what is off
  version                     print the installed version (also --version, -v)
  help                        print this text (also --help, -h)
```

`bellman` with no command prints this, and so does `bellman help`. A command it does not know prints `bellman: unknown command "<name>"` and then this text, both to stderr, and exits 1.

## `bellman update`

Run `bellman update` to move to the latest release. It asks npm for the latest version of `@bellman-sh/mcp-server` with `npm view`, so your own registry, proxy and auth settings apply. If you already have that version, it says so and stops:

```text
bellman 0.3.3 is up to date (latest on npm: 0.3.3).
```

A version newer than npm's latest, such as a clone ahead of the registry, counts as up to date. `update` never downgrades.

When npm has something newer, `update` prints both versions and then does what fits how the package was installed:

| Installed as | What `bellman update` does |
| --- | --- |
| A global npm install, which is what `install.sh` does | Runs `npm install -g @bellman-sh/mcp-server@latest` with npm's own output on your terminal. |
| A clone: a `.git` or `.jj` entry beside the package's `package.json` | Prints `git pull && npm install && npm run build` for you to run in the clone, and runs nothing. |
| A dependency of a project | Prints `npm install @bellman-sh/mcp-server@latest` for you to run in that project, and runs nothing. |

A clone is checked first. `npm link` and `npm install -g <folder>` both put a clone under npm's global root, and a clone is updated with git, not npm.

After a global update it prints `Updated bellman from 0.3.2 to 0.3.3.` and a reminder: Claude Code sessions that are already open keep the old bridge until you restart them.

### Checking first

`bellman update --check` only reports. On a global install it prints the command instead of running it:

```text
bellman 0.3.2 is installed; the latest on npm is 0.3.3.
To update, run: npm install -g @bellman-sh/mcp-server@latest
```

On a clone or a project dependency `update` already runs nothing, so `--check` changes nothing there.

### What it refuses

`update` takes `--check` and nothing else. Any other argument is refused, not skipped, because `bellman update --chek` is a typo for the safe option and read as a plain `update` it would install. The refusal is `bellman: update does not take --chek`, followed by the usage, on stderr, and the exit code is 1.

It also exits 1 when it cannot ask npm for the latest version, because npm is missing or you are offline. If the install itself fails, it exits with npm's own status.

## `bellman doctor`

Run `bellman doctor` when Bellman in Claude Code is not what you expect: the mod shows nothing, an update changed nothing, or a session never hears its room. It reads and asks, and changes nothing. Each line is `ok`, `note`, or `fix`, and each `fix` is followed by the commands that fix it:

```text
fix   The bellman package is 0.4.0; the latest is 0.5.0.
        $ bellman update
ok    One local bridge: MCP server "bellman" in ~/.claude.json (user scope).
fix   The bellman marketplace is not added, so bellman-mod is not installed.
        $ claude plugin marketplace add bellman-sh/bellman
        $ claude plugin install bellman-mod@bellman
ok    The door 2437.sock answers: channel delivery, 2 seats, signed in.
ok    Claude Code is 2.1.310 (bellman-mod was written for 2.1.301; a build without mods skips it quietly).
```

It checks, in this order:

- **The package.** This install's version against npm's latest.
- **The bridges Claude Code starts in this folder.** The plugin, and any MCP server that runs Bellman in `~/.claude.json` (user or local scope) or `.mcp.json` (project scope). A name configured in several scopes counts once, as the highest scope's (local, then project, then user), and a `.mcp.json` server counts only once Claude Code has approved it; one still waiting for approval is a `note`. None means rooms reach no session. More than one means every session runs that many bridges: the fix removes every server when the plugin is an enabled bridge, and otherwise all but one, and it says which stays. A server with a `url` talks to the hosted server directly, with no local bridge, so the mod and the Stop hook see nothing through it.
- **The plugin and the mod.** Whether the bellman marketplace is added, whether each plugin is installed and enabled, and whether it is behind npm. Enabled is read the way Claude Code reads it: `enabledPlugins` merged from `~/.claude/settings.json`, then `.claude/settings.json` and `.claude/settings.local.json` in this folder, the later file winning, and a plugin is enabled only when the merged value is `true`.
- **The doors.** Whether the door folder is closed to other users, which bridges answer on it, their delivery, their seats, and whether each holds a sign-in. A socket nobody listens on was left by a bridge that has exited, and is harmless. A door that did not answer within a second, or answered something else, is reported apart as one that did not answer as expected. The `chmod 700` fix is given only for the default folder and off Windows; for a folder named by `BELLMAN_DOOR_ROOT`, which a bridge leaves as it finds it, an open folder is a `note`.
- **Claude Code.** Its build against the one the mod was written for.

It exits 1 when there is something to fix and 0 otherwise. It reads Claude Code's own files, whose shapes are not a published API, so a file it cannot read is treated as absent. A server's name can come from a cloned repository, so control characters are dropped from what it prints and an argument that is not plain is single-quoted in the commands. Each command is printed once, at its first finding. `doctor` takes no arguments.

## `bellman feature-request`

Run `bellman feature-request` to open GitHub's feature-request form for Bellman. Words after it become the form's title:

```bash
bellman feature-request let me rename a room
```

It prints the URL first, then tries to open your browser: `open` on macOS, `start` on Windows and `xdg-open` elsewhere. On a machine with no browser, such as an SSH session or a container, the printed line is the way in, and failing to open a browser is not an error. The command exits 0 either way.

```text
https://github.com/bellman-sh/bellman/issues/new?template=feature_request.yml&title=let%20me%20rename%20a%20room
```

With no words it prints and opens the blank form. The words are encoded as one title, so an `&` in them stays part of the title and does not start a parameter of its own.

## `bellman version` and `bellman help`

`bellman version` prints the installed version and nothing else. `--version` and `-v` do the same.

`bellman help` prints the [usage](#usage) above. `--help` and `-h` do the same.
