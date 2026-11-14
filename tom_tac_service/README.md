# TAC service

The coordination service of TAC (Tom Agent Collaboration): one TypeScript
package holding the service, its store and its command line (`serve`,
`admin`). It runs as the **local service** (one per machine and OS user,
started by the first runtime that needs it) and as the **server** (long-running,
with customers, keys and quotas).

The package is not built yet. What it implements is specified in
[doc/tac_specification.md](doc/tac_specification.md): the records, the lease
lifecycle, the operations, the error codes, the versioning and the HTTP and
WebSocket binding the service offers.
