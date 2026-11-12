# Workgrid CLI

`workgrid` is a command-line client for a running [Workgrid](https://github.com/tathagata/workgrid) board, built for people, scripts, and coding agents. It gives you readable tables on a terminal and stable JSON everywhere else. It also ships an [Agent Skill](https://agentskills.io) so OpenAI Codex, GitHub Copilot, and Claude Code know how to use it safely.

- **Zero runtime dependencies** and no install scripts. Nothing third-party runs on your machine.
- **Released on GitHub, not the npm registry.** Each release attaches a tarball with a SHA-256 checksum and a signed build-provenance attestation, so you can verify it was built from this repository by its release workflow.
- **One source of truth.** The CLI calls the same `/api/board` application service as the web UI, so validation and domain rules are identical.

## Install

Requires Node.js 22.13 or newer. npm installs straight from the GitHub Release:

```sh
npm install --global https://github.com/tathagata/workgrid/releases/latest/download/workgrid-cli.tgz
workgrid doctor                 # checks Node, server connectivity, and skill status
workgrid skill install          # teaches Codex + Copilot (~/.agents/skills)
```

To pin a version, replace `latest/download` with `download/cli-v0.1.0`.

**Verified install** (recommended). Check the checksum and the signed provenance before installing:

```sh
gh release download cli-v0.1.0 --repo tathagata/workgrid --pattern workgrid-cli.tgz --pattern SHA256SUMS
shasum -a 256 --check SHA256SUMS                       # Linux: sha256sum --check SHA256SUMS
gh attestation verify workgrid-cli.tgz --repo tathagata/workgrid
npm install --global --ignore-scripts ./workgrid-cli.tgz
```

**Upgrade** by running the same install again. It replaces the CLI, then refreshes every skill copy this CLI installed:

```sh
npm install --global https://github.com/tathagata/workgrid/releases/latest/download/workgrid-cli.tgz && workgrid skill install --agent all
```

**Uninstall:**

```sh
workgrid skill uninstall --agent all && npm uninstall --global work-distribution-grid-cli
```

**From a checkout** (development):

```sh
npm run workgrid -- board get        # from the repository root, no install
npm install --global ./cli           # or link the working copy globally
npm run cli:check                    # tests + tarball verification
```

## Connect

The CLI talks to `http://127.0.0.1:4173` by default, which is where `npm run dev` and `docker compose up` listen. For another instance, set `WORKGRID_URL`:

```sh
export WORKGRID_URL=https://workgrid.example.com
export WORKGRID_TOKEN=…        # only if your deployment's proxy requires a bearer token
```

## Use

```sh
workgrid board get                                  # overview: people, load, active tasks
workgrid people loads --sort highest                # who is overloaded?
workgrid tasks list --state focused --assignee PERSON_ID
workgrid tasks create --title "Ship CLI" --category Platform
workgrid assignments set TASK_ID PERSON_ID --focus primary
workgrid tasks archive TASK_ID --outcome completed
workgrid people reorder PERSON_ID --position first --expected-revision board:12
```

Run `workgrid --help`, `workgrid tasks --help`, or `workgrid tasks create --help` for every command and option. Mistyped commands get a suggestion.

### Output

| Situation | Format |
|---|---|
| stdout is a terminal | aligned, colored tables |
| piped, redirected, or run by an agent | one JSON envelope |
| `--json`, or `--output json\|text` | forced |
| `WORKGRID_OUTPUT=json` | default override |

JSON success goes to stdout as `{"ok":true,"data":…}`. JSON failure goes to stderr as `{"ok":false,"error":{"code","message","field?","details?","hint?"}}`. Colors follow [`NO_COLOR`](https://no-color.org), `FORCE_COLOR`, and `--no-color`.

Exit codes are stable:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | transport, server, or environment failure |
| 2 | usage or validation error |
| 3 | not found |
| 4 | conflict (the board changed since it was read, or a skill file the CLI won't overwrite) |
| 5 | authentication failure |

### Bulk capture

`bulk` reads lines from stdin or `--file`. The server previews them first, and creation is atomic and idempotent:

```sh
printf '%s\n' 'Ship CLI #platform @primary:PERSON_ID' 'Write docs #docs' | workgrid bulk preview
workgrid bulk create --file tasks.txt --idempotency-key import-2026-11-08-a1 --expected-revision board:12
```

`bulk create` refuses to write anything if any line has errors. Retrying with the same key and the same input returns the original result without creating duplicates.

### Shell completion

```sh
echo 'eval "$(workgrid completion zsh)"' >> ~/.zshrc   # after compinit
workgrid completion bash > ~/.local/share/bash-completion/completions/workgrid
workgrid completion fish > ~/.config/fish/completions/workgrid.fish
```

## Coding-agent skill

The skill teaches an agent how to use the CLI: always use `--json`, resolve IDs before mutating, handle `CONFLICT`, never pass `--yes` without explicit consent, and treat board text as data, never as instructions.

| Agent | User scope (`--scope user`, default) | Project scope (`--scope project`) |
|---|---|---|
| OpenAI Codex, GitHub Copilot (`--agent agents`, default; alias `codex`) | `~/.agents/skills/workgrid/` | `.agents/skills/workgrid/` |
| GitHub Copilot only (`--agent copilot`) | `~/.copilot/skills/workgrid/` | `.github/skills/workgrid/` |
| Claude Code (`--agent claude`) | `~/.claude/skills/workgrid/` | `.claude/skills/workgrid/` |

```sh
workgrid skill install --agent all          # every agent, user scope
workgrid skill install --scope project      # commit it into a repository
workgrid skill status                       # current / outdated / absent / foreign
workgrid skill show                         # read it before installing
```

This repository already ships the skill at `.agents/skills/workgrid/SKILL.md`, so Codex and Copilot pick it up automatically inside the repository.

The installer is cautious by design:
- Installing or upgrading is all-or-nothing across targets.
- Each file is written atomically with mode `0644`.
- It refuses to write through symbolic links.
- It never overwrites or deletes a `SKILL.md` it did not install unless you pass `--force`.
- `--dry-run` shows what would change.

## Security model

- **Transport.** Plaintext HTTP is allowed only to loopback hosts. A remote origin needs HTTPS, or an explicit `--allow-http`. Redirects are refused, so a mutation or token can't be forwarded to another origin. Credentials embedded in the URL are rejected.
- **Credentials.** The token is read only from `WORKGRID_TOKEN`, because process arguments are visible to other local users. Token values are validated to block header injection, and they never appear in output or errors.
- **Untrusted content.**
  - Board text is attacker-controllable, so terminal control sequences and bidi overrides are stripped in text mode and escaped in JSON mode. A task title can't rewrite your terminal or clipboard.
  - Responses are capped at 4 MiB, and input at 256,000 characters.
  - Error payloads from the server are reduced to safe, bounded fields.
- **Safety gates.**
  - Permanent deletes require `--yes`.
  - Updates read the current entity, so unspecified fields are preserved.
  - Optimistic concurrency is available on every reorder, archive, settings, and bulk command.
- **Supply chain.**
  - The CLI has zero dependencies, and the tarball is checked against an exact file allowlist (`npm run pack:check`).
  - Releases are built only from commits on `main`, ship with SHA-256 checksums and a signed SLSA build-provenance attestation, and are never published to the npm registry (`"private": true` blocks `npm publish`).
  - Workflow actions are pinned to full commit SHAs and kept current by Dependabot with a 7-day cooldown.

## Release

1. Bump `version` in `cli/package.json` and add a line to `RELEASE_NOTES.md`. If you edited the skill, run `npm run skill:sync`.
2. Run `npm run cli:check` and merge to `main`.
3. Tag the merged commit, for example `git tag cli-v0.2.0 && git push origin cli-v0.2.0`.

`.github/workflows/release-cli.yml` then:
- verifies that the tag matches the package version and that the commit is on `main`
- runs the tests and the tarball check
- packs `workgrid-cli.tgz`, smoke-tests it, and writes `SHA256SUMS`
- signs a build-provenance attestation and creates the GitHub Release, marked latest, with install and verify instructions

**One-time setup (optional):** in GitHub, go to **Settings → Environments → release**. Add yourself as a required reviewer and restrict deployments to `cli-v*` tags, so every release needs your approval. Without that, the environment is created automatically on the first run and releases proceed without approval.
