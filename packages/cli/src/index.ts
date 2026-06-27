/** Stable package identifier for the factory CLI. */
export const CLI_PACKAGE_NAME = '@software-factory/cli' as const;

// The `software-factory` command surface (start/run/status/events/artifacts) and
// the Claude/Codex skill wrappers are implemented in U10. They connect to the
// local web/API using the same operator-token model as the Factory Floor UI.
