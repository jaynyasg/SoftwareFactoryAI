# Worker skills (packaged with the factory)

Skills in this directory are for the factory's **worker CLIs** (`claude` /
`codex`), not for humans calling the factory (those inbound wrappers live in
`skills/claude` and `skills/codex`).

Worker CLIs discover skills from the executing machine's home directory
(`~/.claude/skills` and `~/.codex/skills`) — they are a machine-level
dependency. This directory vendors the skills the factory wants its workers to
have so that ANY machine (a teammate's laptop, a fresh cloud container) can be
provisioned identically:

```bash
node scripts/install-worker-skills.mjs
```

copies every `skills/worker/<name>/` directory into BOTH families' skill dirs.
The Dockerfile runs it at image build time, so cloud workers boot with these
skills already installed.

## Granting access

Installation alone is not enough for Claude workers — skill access is
fail-closed. Set:

- `SF_CLAUDE_ALLOWED_SKILLS` — comma-separated skill names workers may invoke
  (or `*` for all installed skills; avoid `*` in cloud).
- `SF_PREFERRED_SKILLS` — names to steer workers toward (both families).

Codex loads `~/.codex/skills` natively; only the preference steering applies.

## Adding a skill

Create `skills/worker/<skill-name>/SKILL.md` with standard frontmatter
(`name`, `description`). Keep worker skills inward-facing (code discipline,
conventions, testing) — outward-facing skills (deploy, publish, email) are
exactly what the fail-closed default protects against.
