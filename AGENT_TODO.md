[x] the API key I set that is safely saved in the system keychain is being exposed as an env to the agent, find a way to fix it.
    Fixed in three layers, because each one alone leaked it:

    1. launch() pipes the key to `ori login --with-key` (stdin, never argv) and
       verifies with `ori auth --json`, clearing a stale saved login choice if
       it shadows the stored key.
    2. Every ori child env is stripped of OPENROUTER_API_KEY / OR_API_KEY /
       OPENROUTER_KEY. Not enough: `ori pi` re-exports the stored credential
       into the harness it launches, so the agent still saw it.
    3. src/routing-extension.ts (loaded inside Pi) deletes those variables at
       module load and at the start of every `before_provider_request`.
       Pi then needs a credential source that is not the environment, so
       src/pi-auth.ts writes ~/.pi/agent/auth.json:
         {"openrouter": {"type": "api_key", "key": "!keyring get openrouter orp-api-key"}}
       Pi runs that command on demand (docs/providers.md#load-an-api-key-from-a-command);
       the key stays in the OS keyring. Falls back to a plaintext 0600 entry
       only when no keyring backend can store it. ORP_KEEP_KEY_ENV=1 disables
       the scrub for diagnostics.
