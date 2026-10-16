---
title: The bellman command
description: bellman update, bellman feature-request and bellman version, from the npm package.
---

`bellman` is a command you run in a terminal. It is not one of the tools your agent calls. It updates the npm package, opens the feature-request form on GitHub, and prints the installed version.

The npm package, `@bellman-sh/mcp-server`, puts `bellman` on your PATH, and the installer at `https://bellman.sh/install.sh` installs that package. The Claude Code plugin does not, so a machine with only the plugin has no `bellman` command. To take the plugin's next release, run `claude plugin update bellman@bellman`.

## Usage

```text
Usage: bellman <command>

  feature-request [words...]  open the feature-request form on GitHub; the words become its title
  update [--check]            install the latest release from npm; --check only reports
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
