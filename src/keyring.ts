import { spawnSync } from "node:child_process";

/**
 * Thin wrapper around the freedesktop Secret Service.
 *
 * Prefers `secret-tool` (libsecret-tools), falls back to the Python `keyring`
 * CLI that ships with Ubuntu. Reading a locked keyring triggers the normal
 * GNOME Keyring / Secret Service unlock prompt.
 */

const SERVICE = "openrouter";
const ACCOUNT = "orp-api-key";
const LABEL = "OpenRouter API key for orp";
const TIMEOUT_MS = 30_000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input?: string): Result | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    timeout: TIMEOUT_MS,
  });
  if (result.error) return undefined;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function available(command: string): boolean {
  const result = run("sh", ["-c", `command -v ${command} >/dev/null 2>&1`]);
  return result?.status === 0;
}

export type KeyringBackend = "secret-tool" | "keyring" | undefined;

export function keyringBackend(): KeyringBackend {
  if (available("secret-tool")) return "secret-tool";
  if (available("keyring")) return "keyring";
  return undefined;
}

export function getKeyringKey(): string | undefined {
  const backend = keyringBackend();
  if (!backend) return undefined;

  const result =
    backend === "secret-tool"
      ? run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT])
      : run("keyring", ["get", SERVICE, ACCOUNT]);

  if (result?.status !== 0) return undefined;
  const key = result.stdout.trim();
  return key.length > 0 ? key : undefined;
}

export function setKeyringKey(key: string): boolean {
  const backend = keyringBackend();
  if (!backend) return false;

  const result =
    backend === "secret-tool"
      ? run(
          "secret-tool",
          ["store", "--label", LABEL, "service", SERVICE, "account", ACCOUNT],
          `${key}\n`
        )
      : run("keyring", ["set", SERVICE, ACCOUNT], `${key}\n`);

  return result?.status === 0;
}

export function deleteKeyringKey(): boolean {
  const backend = keyringBackend();
  if (!backend) return false;

  const result =
    backend === "secret-tool"
      ? run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT])
      : run("keyring", ["del", SERVICE, ACCOUNT]);

  return result?.status === 0;
}

export function keyringLocation(): string {
  const backend = keyringBackend();
  return backend ? `${backend} (service=${SERVICE}, account=${ACCOUNT})` : "unavailable";
}