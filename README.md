# orp — OpenRouter provider picker for `ori pi`

`orp` answers one question for a model you already chose:

> Which OpenRouter upstream provider should I use, and how do I launch `ori pi` pinned to it?

It fetches the model's endpoint data, shows the top 5 providers by price (with
throughput, latency, and uptime), lets you pick one, then launches:

```bash
ori pi --model <model> -- -e <routing-extension.ts>
```

with `OPENROUTER_PROVIDER_ORDER=<provider>` set for that process. A small Pi
extension adds this to every request:

```json
{
  "provider": {
    "order": ["deepinfra"],
    "allow_fallbacks": true
  }
}
```

`pi --provider` is **not** used for this: it selects the Pi provider adapter
(`openrouter`, `anthropic`, etc.), not OpenRouter's upstream inference provider.

---

## Requirements

**Bun** (tested 1.4.x)

- Runs the TypeScript sources directly.
- No build step or `tsx` dependency.
- `bin/orp` refuses to start without it.

**`ori`**

- Required at launch time.
- `orp` spawns `ori pi --model <id> -- -e <routing-extension>`.

**`pi`**

- Launched by `ori pi`.
- Must be installed and supported by your Ori version.

**OpenRouter API key**

- Optional for startup, but required for OpenRouter to return
  `throughput_last_30m` and `latency_last_30m`.
- Without it, the tps and latency columns are blank.

The key can come from, in order:

1. `--api-key`
2. `OPENROUTER_API_KEY`, `OR_API_KEY`, or `OPENROUTER_KEY`
3. The OS keyring (`service=openrouter`, `account=orp-api-key`)
4. An interactive hidden prompt, which saves it to the keyring when possible

---

## Install

```bash
cd /home/reflectored/Development/openrouter_pricer
./install.sh
```

`install.sh`:

- checks for Bun
- runs `bun install`
- makes `bin/orp` executable
- symlinks `~/.local/bin/orp` to `bin/orp`
- warns if `~/.local/bin` is not on `PATH`

Or manually:

```bash
cd /home/reflectored/Development/openrouter_pricer
bun install
chmod +x bin/orp
ln -sf "$PWD/bin/orp" ~/.local/bin/orp
```

Make sure `~/.local/bin` is on `PATH`.

---

## Uninstall

```bash
./uninstall.sh            # remove the ~/.local/bin/orp symlink
./uninstall.sh --purge    # also remove node_modules
```

The project files and `bun.lock` are left intact.

---

## Usage

You already know the model, so pass it:

```bash
orp --model deepseek/deepseek-chat
```

The wrapper:

1. calls `GET /api/v1/models/<author>/<slug>/endpoints`
2. shows the top 5 providers by total $/M (input + output), with tps, latency,
   and uptime
3. lets you choose a provider
4. confirms, then launches `ori pi` pinned to that provider

Set `MODEL` instead of passing `--model`:

```bash
MODEL=deepseek/deepseek-chat orp
```

### Examples

Interactive picker and launch:

```bash
orp -m deepseek/deepseek-chat
```

Preselect a provider and skip the picker/confirmation:

```bash
orp -m deepseek/deepseek-chat --provider deepinfra --yes
```

Rank by throughput instead of price:

```bash
orp -m deepseek/deepseek-chat --sort tps
```

Only print the table:

```bash
orp -m deepseek/deepseek-chat --list
```

Machine-readable output:

```bash
orp -m deepseek/deepseek-chat --json
```

Pick without launching:

```bash
orp -m deepseek/deepseek-chat --no-launch
```

Forward arguments to `ori pi`:

```bash
orp -m deepseek/deepseek-chat -- --continue
```

---

## Options

**Model**

- `--model, -m <id>` — OpenRouter model id (also `MODEL` / `OPENROUTER_MODEL`)

**Provider selection**

- `--api-key <key>` — key for the pricing API; overrides env and keyring
- `--no-keyring` — do not read or prompt the OS keyring
- `--provider <slug>` — preselect provider and skip the picker
- `--sort <mode>` — ranking for the top 5 table: `price`, `tps`, or `value`
  (default `price`)
- `--no-fallback` — set `allow_fallbacks: false`
- `--reasoning-effort <level>` — forwarded to `ori pi`

**Keyring**

- `orp key status` — show backend and whether a key is stored
- `orp key set` — prompt for a key and save it to the OS keyring
- `orp key clear` — delete the stored key

**Output and launch**

- `--list` — print the table and exit
- `--json` — print JSON and exit
- `--no-launch` — pick a provider without launching `ori pi`
- `--yes, -y` — skip the launch confirmation
- `-- <args>` — forward remaining args to `ori pi`

Unknown flags before `--` are also forwarded to `ori pi`.

---

## Keyring on Ubuntu (GNOME / Wayland)

Ubuntu provides GNOME Keyring through the Secret Service. `orp` prefers
`secret-tool` and falls back to the Python `keyring` CLI.

```bash
sudo apt install libsecret-tools   # optional; provides secret-tool

orp key set      # hidden prompt, saves via the OS keyring
orp key status   # backend + whether a key is stored; never prints the key
orp key clear    # delete the stored key
```

If the login keyring is locked, the normal GNOME unlock prompt appears when
`orp` reads or writes the secret.

Manual `secret-tool` equivalent:

```bash
secret-tool store \
  --label='OpenRouter API key for orp' \
  service openrouter account orp-api-key
```

Manual Python `keyring` equivalent:

```bash
keyring set openrouter orp-api-key
```

Check without printing the key:

```bash
test -n "$(secret-tool lookup service openrouter account orp-api-key)" \
  && echo "key stored" || echo "no key"
```

`orp` does not read Ori's SQLite credential stores. Ori's usable credential is
either in the environment or in its encrypted login store. The plaintext
`~/.ori/auth/plaintext/keys.sqlite` value found during development was not a
usable bearer token.

Security note: an unlocked GNOME keyring is readable by processes in your login
session. Use a credit-limited OpenRouter key for `orp`.

---

## Why tps/latency may be blank

OpenRouter returns `throughput_last_30m` and `latency_last_30m` from
`/models/<id>/endpoints` only for authenticated requests.

Without a key:

```json
{
  "throughput_last_30m": null,
  "latency_last_30m": null
}
```

With a key:

```json
{
  "throughput_last_30m": { "p50": 45, "p75": 36, "p90": 28, "p99": 21 },
  "latency_last_30m": { "p50": 1078, "p75": 1290, "p90": 1740, "p99": 3554 }
}
```

So `orp` warns and leaves those columns blank when no key is available. The API
reports latency in milliseconds; `orp` displays it in seconds.

There is no way to send a hashed key: OpenRouter only accepts the raw secret as
`Authorization: Bearer <key>`. The server hashes the presented value for
comparison; sending a hash produces `401`.

---

## What the routing extension does

`src/routing-extension.ts` is loaded with Pi's `-e` flag. It registers a
`before_provider_request` handler that reads:

- `OPENROUTER_PROVIDER_ORDER` — comma-separated provider slugs
- `OPENROUTER_ALLOW_FALLBACKS` — `0` or `1`

It merges this into the request payload:

```json
{
  "provider": {
    "order": ["<slug>"],
    "allow_fallbacks": true
  }
}
```

It only acts when the active Pi provider is `openrouter` or unspecified.

Provider slugs are derived from the endpoint's `tag`, for example:

- `deepinfra/fp4/flex` becomes `deepinfra`
- `streamlake` becomes `streamlake`
- `anthropic` becomes `anthropic`

If several endpoints belong to the same provider, `orp` keeps the best one for
that provider for the ranking table.

---

## Dependencies

### Runtime

**Bun** (1.4.x tested)

- Runs TypeScript directly.
- `bin/orp` refuses to start without it.

**`ori`**

- Spawned to launch `ori pi` with the routing extension.

**`pi`**

- Launched by `ori pi`.

**OpenRouter key**

- Needed for tps and latency.
- Not needed to print prices.

### npm dependency

Only one direct runtime dependency is declared in `package.json`:

**`@clack/prompts` (`^1.8.1`)**

- Interactive provider selection
- Launch confirmation
- Hidden API-key prompt

Transitive packages installed through `bun.lock`:

- `@clack/core` — prompt engine
- `fast-string-width` and `fast-string-truncated-width` — ANSI-aware string sizing
- `fast-wrap-ansi` — ANSI-aware wrapping
- `sisteransi` — terminal escape sequences

All are installed by `bun install`. None are imported directly by `orp`.

### Standard library only

No OpenRouter SDK, OpenAI SDK, dotenv package, proxy server, or CLI framework is
used beyond the standard library:

- `node:child_process` — `spawnSync` for `ori`, `keyring`, and `secret-tool`
- `node:url` — resolving `routing-extension.ts`
- global `fetch` — OpenRouter endpoints API
- `process.env` — model, key, and base-URL resolution

### Optional system tools

**`secret-tool` (`libsecret-tools`)**

- Preferred Secret Service / GNOME Keyring backend.

**`keyring` (`python3-keyring`)**

- Fallback keyring backend when `secret-tool` is missing.
- Already present on this Ubuntu install.

**GNOME Keyring / Secret Service (`gnome-keyring`)**

- Provides the unlock prompt and encrypted storage behind either backend.

If neither keyring backend exists, `orp` still works but cannot persist keys and
will warn.

---

## Files

`bin/orp`

- Launcher. Resolves symlinks, then runs Bun.

`src/index.ts`

- CLI parsing, OpenRouter fetch, ranking, and launch.

`src/routing-extension.ts`

- Pi `before_provider_request` injection.

`src/keyring.ts`

- `secret-tool` / `keyring` wrapper.

`install.sh`

- Installs dependencies and creates the symlink.

`uninstall.sh`

- Removes the symlink. `--purge` also removes `node_modules`.

`package.json`

- One direct dependency: `@clack/prompts`.

`bun.lock`

- Locked dependency tree.

---

## Troubleshooting

### `orp: bun is required but was not found in PATH`

Install Bun: <https://bun.sh>

### tps and latency show `—`

No API key was found. Run `orp key set`, export `OPENROUTER_API_KEY`, or pass
`--api-key`.

### `Unknown provider "deepinfra"`

You passed Pi's `--provider`. That selects a Pi provider adapter, not an
OpenRouter upstream provider. Let `orp` inject the provider order instead.

### `ori pi` starts but the provider is not pinned

Check that the extension loads:

```bash
pi --no-mcp --no-session -e ./src/routing-extension.ts --help
```

Then verify `OPENROUTER_PROVIDER_ORDER` is set in the environment of the `ori`
process.

### Keyring prompt does not appear

Make sure a Secret Service provider is running:

```bash
gdbus call --session \
  --dest org.freedesktop.DBus \
  --object-path /org/freedesktop/DBus \
  --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets
```

Expected output: `(true,)`
