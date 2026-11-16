/**
 * Pi's own credential store.
 *
 * `ori pi` re-exports the credential it resolves as `OPENROUTER_API_KEY` for
 * the harness it launches, and the routing extension orp injects strips that
 * variable so the agent's shell cannot read it. Pi then needs a key source that
 * is not the environment: `auth.json` accepts
 *
 *   {"openrouter": {"type": "api_key", "key": "!<command>"}}
 *
 * and runs the command when the key is first needed, caching the output for the
 * process lifetime (pi docs, `docs/providers.md#load-an-api-key-from-a-command`).
 * orp therefore points Pi at the OS keyring it already uses, instead of putting
 * the secret in a file or in the environment.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  getKeyringKey,
  keyringBackend,
  keyringLookupCommand,
  setKeyringKey,
} from "./keyring.ts";

export interface PiCredentialResult {
  ok: boolean;
  detail: string;
}

export function piAgentDir(): string {
  const fromEnv =
    process.env.PI_AGENT_DIR?.trim() || process.env.PI_CONFIG_DIR?.trim();
  return fromEnv || join(homedir(), ".pi", "agent");
}

export function piAuthJsonPath(): string {
  return join(piAgentDir(), "auth.json");
}

/**
 * Ensure `auth.json` has an OpenRouter credential orp can vouch for. An
 * existing non-API-key credential (OAuth login) is left untouched — it already
 * works without the environment.
 */
export function ensurePiCredential(key: string): PiCredentialResult {
  const path = piAuthJsonPath();

  let body: Record<string, any> = {};
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw) body = JSON.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, detail: `${path}: ${(error as Error).message}` };
    }
  }

  const existing = body.openrouter;
  if (existing?.type && existing.type !== "api_key") {
    return {
      ok: true,
      detail: `${path} (kept existing ${existing.type} credential)`,
    };
  }

  // Only touch the keyring when it does not already hold this key: a locked
  // keyring can block on an unlock prompt, and every launch would pay for it.
  let command = keyringBackend() ? keyringLookupCommand() : undefined;
  if (command && getKeyringKey() !== key && !setKeyringKey(key)) {
    command = undefined;
  }
  const entry = command ? `!${command}` : key;

  if (existing?.key === entry) return { ok: true, detail: path };

  body.openrouter = { type: "api_key", key: entry };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    return { ok: false, detail: `${path}: ${(error as Error).message}` };
  }

  return {
    ok: true,
    detail: command
      ? `${path} (key fetched from the keyring on demand)`
      : `${path} (plaintext key; no keyring backend for a command source)`,
  };
}
