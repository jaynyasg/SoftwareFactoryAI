# Software Factory AI — cloud image with EXECUTION support.
#
# The plain Node deployment (render.yaml's old buildCommand) could plan runs
# but never execute them: no worker CLI existed on the host. This image bakes
# in the `claude` + `codex` CLIs and the vendored worker skills, so a cloud
# instance runs tickets exactly like a laptop does. Auth arrives at runtime
# via env vars (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY)
# — see scripts/docker-entrypoint.sh.
FROM node:22-bookworm-slim

# git: repo checkout + publish; ca-certificates: HTTPS everywhere;
# curl: health-check debugging from a shell.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Worker CLIs on PATH for the execution adapters (root-owned, world-readable).
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# pnpm via corepack, pinned by the repo's packageManager field.
RUN corepack enable

# Non-root runtime user. HOME carries the CLIs' credentials and the installed
# worker skills, so it must be a real writable home directory.
RUN useradd --create-home --shell /bin/bash factory

WORKDIR /app
# WORKDIR creates /app as root; hand it to the runtime user BEFORE the copy so
# pnpm (running as `factory`) can write its temp/lockfile state at the root.
RUN chown factory:factory /app
COPY --chown=factory:factory . .
# A Windows/OneDrive build context maps read-only attributes into the image as
# r-x modes (and --chown missed directories), so pnpm's node_modules mkdir
# failed even for the owner. The tree is source-only (.dockerignore drops
# node_modules/.next), so a recursive chown + owner-writable chmod is cheap
# and makes the layout deterministic regardless of host filesystem quirks.
RUN chown -R factory:factory /app && chmod -R u+rwX /app

USER factory
ENV HOME=/home/factory

RUN corepack pnpm install --frozen-lockfile \
  && corepack pnpm --filter @software-factory/web build \
  # Vendored worker skills -> ~/.claude/skills + ~/.codex/skills, so workers
  # boot with the factory's conventions installed (grant via
  # SF_CLAUDE_ALLOWED_SKILLS in the service env).
  && node scripts/install-worker-skills.mjs

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]
