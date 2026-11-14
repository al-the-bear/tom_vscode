/**
 * tom-tac-service: the TAC coordination service, local mode.
 *
 * - `./protocol/*` — the protocol types a client depends on (records, keys, errors).
 * - `TacService` — the operations over the store, transport-free.
 * - `startLocalService` — the local service as a process (port, key file, idle stop).
 * - `ensureLocalService` — how a runtime finds or starts its machine's service.
 * - `TacClient` — a thin typed client of the HTTP and WebSocket binding.
 */
export * from './protocol/types';
export * from './protocol/errors';
export * from './protocol/keys';
export { ulid, isUlid } from './util/ulid';
export { Store } from './store/store';
export { TacService } from './service/service';
export { TacHttpServer } from './http/server';
export {
    startLocalService, resolveConfig, readConfigFile, defaultConfig, defaultStoreDir, ensureKeyFile, readKeyFile, readServiceJson,
    DEFAULT_PORT, DEFAULT_HOST, DEFAULT_IDLE_MINUTES,
} from './local';
export type { LocalConfig, RunningService, StartResult } from './local';
export { ensureLocalService } from './launcher';
export type { EnsureOptions, EnsureResult } from './launcher';
export { TacClient } from './client';
