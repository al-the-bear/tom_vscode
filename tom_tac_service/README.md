# TAC service

The coordination service of TAC (Tom Agent Collaboration): one TypeScript
package holding the service, its store and its command line. The runtimes of
an agent group use it to claim repositories (leases with fencing tokens),
register their presence and sessions, exchange notifications and commands, and
publish their endpoints. What it implements is specified in
[doc/tac_specification.md](doc/tac_specification.md) (`tac/1.0`): the records,
the lease lifecycle, the operations, the error codes, the versioning and the
HTTP and WebSocket binding.

This package runs the **local mode**: one service per machine and OS user,
on `127.0.0.1:19890`, serving every runtime, window and workspace of that
user. The server mode (customers, keys, quotas, network access) comes later.

It has no runtime dependencies, so a runtime starts it from its own
installation with its own Node (22 or later).

## Starting it

### From a runtime

A runtime calls `ensureLocalService()`:

```ts
import { ensureLocalService, TacClient } from 'tom-tac-service';

const { baseUrl, key, status } = await ensureLocalService();   // status: 'found' | 'started'
const client = new TacClient({ baseUrl, key });
await client.hello('my-group', { settings: { autoUpdate: false } });
```

1. It sends `hello` to `127.0.0.1:19890` and uses the service that answers
   with the same major version.
2. If nothing answers, it starts the service as a detached child process with
   the runtime's own Node (`process.execPath`, with `ELECTRON_RUN_AS_NODE=1`
   so the VS Code extension host's Electron runs as Node). The child outlives
   the window that started it.
3. It retries `hello` for up to 10 seconds. Two runtimes starting it at the
   same moment end up on the one service that bound the port: the port is the
   lock, and the second service exits at once.
4. A port held by a program that is not TAC is refused (`unreachable`), never
   taken. A TAC service of another major version is asked to hand over
   (`POST /tac/1/admin/handover`) and replaced by this runtime's copy.

### Standalone

```text
npm install && npm run compile
node dist/src/cli.js serve [--config <file>] [--host <h>] [--port <n>] [--store <dir>]
                           [--idle-minutes <n>] [--keep-running]
node dist/src/cli.js admin status|stop [--port <n>] [--store <dir>]
node dist/src/cli.js --version
```

`serve` exits with 3 when another service already holds the port (that one is
used instead), 1 on an error, 0 after a stop.

## Where it keeps its state

| Path | Holds |
| --- | --- |
| `~/.tom/coordination/` (Windows: `%USERPROFILE%\.tom\coordination\`) | the store folder, one per machine and OS user (`--store` changes it) |
| `<store>/local.key` | the bearer key, written at the first start with mode 0600; a runtime of the same OS user reads it, another user cannot |
| `<store>/config.yaml` | the machine's service config (optional): `port`, `host`, `idleMinutes` (default 15), `keepRunning`, `maxPayloadBytes`, `storeDir`; top-level `key: value` lines, or JSON |
| `<store>/service.json` | the running service's pid, port, version and start time; information for the user, not the lock, removed on a clean stop |
| `<store>/store.json` | the store's `formatVersion`; a newer one than the service knows refuses the start |
| `<store>/groups/<groupId>/journal.jsonl`, `snapshot.json` | the group's state: an append-only journal (each change flushed before it is acknowledged) and a snapshot written from time to time and at the stop |

## How long it runs

- It stays up while any runtime has its stream open, because an open stream
  counts as access.
- Once the last stream has closed and no request has come for `idleMinutes`
  (default 15), it writes a final snapshot and exits. The next runtime starts
  it again.
- With `keepRunning: true` it skips the idle stop and runs until it is stopped
  (`admin stop`) or the machine restarts.
- Leases, registrations, stored commands and endpoints outlive a stop. A lease
  whose 60 minutes passed while the service was stopped reads as stale when it
  starts again.

## The package

| Module | Does |
| --- | --- |
| `src/protocol/` | the protocol types a client depends on: records (`types.ts`), error codes and HTTP statuses (`errors.ts`), session and resource keys and their conflicts (`keys.ts`) |
| `src/store/store.ts` | the journal and snapshot per group |
| `src/service/service.ts` | the TAC operations over the store, transport-free, with an injectable clock |
| `src/http/` | the HTTP routes and the WebSocket stream (a minimal RFC 6455 server) |
| `src/local.ts` | the local service as a process: config, key file, `service.json`, idle stop |
| `src/launcher.ts` | `ensureLocalService`: how a runtime finds or starts the service |
| `src/client.ts` | `TacClient`: a thin typed client, one method per operation, plus `subscribe` |
| `src/cli.ts` | the command line |

## Tests

```text
npm test
```

compiles and runs every test with Node's test runner, without a runtime. They
cover the key rules, the store's persistence and crash cases, every operation
and the lease lifecycle on a fake clock, two clients coordinating leases and
messages through a running service over HTTP and WebSocket, and the launcher
starting real detached services. Scratch folders go under `dist/scratch/`.
