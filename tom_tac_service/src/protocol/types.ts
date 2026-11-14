/**
 * The TAC records (doc/tac_specification.md § 3) as TypeScript types.
 *
 * This module and `errors.ts` / `keys.ts` are the protocol types a client
 * depends on; they import nothing from the service.
 */

export const PROTOCOL_VERSION = 'tac/1.0';
export const PROTOCOL_MAJOR = 1;
/** The store format this service reads and writes (§ 8). */
export const FORMAT_VERSION = 1;

/** UTC ISO 8601 with milliseconds and `Z`, always the backend's clock. */
export type Time = string;

export type GroupMode = 'local' | 'github' | 'server';

export interface BackendIdentity {
    mode: GroupMode | 'off';
    repository?: string;
    serverUrl?: string;
    groupId?: string;
}

export interface GroupSettings {
    branchGranularity?: 'none' | 'item' | 'group';
    autoUpdate?: boolean;
    extra?: Record<string, unknown>;
    [other: string]: unknown;
}

export interface Unit {
    repository: string;
    path: string;
    shared?: string[];
    description?: string;
}

export interface InfraResource {
    name: string;
    description?: string;
}

export interface Group {
    protocolVersion?: string;
    groupId: string;
    customerId: string;
    mode: GroupMode;
    settings: GroupSettings;
    units: Unit[];
    infra: InfraResource[];
    createdAt: Time;
    migratedTo?: BackendIdentity;
    [other: string]: unknown;
}

export interface Clone {
    repository: string;
    path: string;
    head?: string;
    behind?: number;
    ahead?: number;
    dirty?: boolean;
}

export interface RuntimeStatus {
    process?: Record<string, unknown>;
    openQuestions?: number;
    openItems?: number;
    openReviews?: number;
    queue?: 'idle' | 'sending' | 'paused' | 'stopped';
    [other: string]: unknown;
}

export type RuntimeKind = 'vscode' | 'webforge' | 'runtime-server';

export interface Runtime {
    protocolVersion?: string;
    runtimeId: string;
    groupId: string;
    kind: RuntimeKind;
    host: string;
    workspace: string;
    workspaceRoot: string;
    quests: string[];
    hasQuest: boolean;
    clones: Clone[];
    backend?: BackendIdentity;
    repositories?: string[];
    status?: RuntimeStatus;
    registeredAt: Time;
    presenceRenewedAt: Time;
    /** Computed by the backend on every read; never stored from a client. */
    present?: boolean;
    [other: string]: unknown;
}

export interface SessionKey {
    quest: string;
    session: string;
    run: string;
    host: string;
    workspace: string;
}

export interface CurrentItem {
    itemId: string;
    todoId?: string;
}

export interface Session {
    protocolVersion?: string;
    sessionKey: SessionKey;
    runtimeId: string;
    lastActivity: Time;
    currentItem?: CurrentItem;
    openedAt: Time;
    [other: string]: unknown;
}

export type Hold = 'item' | 'group';

export interface LeaseResource {
    key: string;
    token: number;
    acquiredAt: Time;
    hold: Hold;
    branch?: string;
    worktree?: string;
}

export type LeaseState = 'active' | 'stale' | 'freed' | 'released';

export interface Lease {
    protocolVersion?: string;
    leaseId: string;
    groupId: string;
    sessionKey: SessionKey;
    resources: LeaseResource[];
    acquiredAt: Time;
    renewedAt: Time;
    expiresAt: Time;
    state: LeaseState;
    freedAt?: Time;
    freedBy?: string;
    [other: string]: unknown;
}

export type MessageClass = 'notification' | 'command';
export type DeliveryState = 'pending' | 'delivered' | 'acknowledged' | 'expired';
export type AckOutcome = 'taken' | 'refused' | 'filed';

export interface Origin {
    sessionKey?: SessionKey;
    quest: string;
    run?: string;
    host: string;
    runtimeId: string;
}

export interface Delivery {
    quest: string;
    state: DeliveryState;
    deliveredTo: string[];
    acknowledgedBy?: string;
    acknowledgedAt?: Time;
    outcome?: AckOutcome;
    reason?: string;
    expiresAt: Time;
}

export interface Message {
    protocolVersion?: string;
    messageId: string;
    class: MessageClass;
    type: string;
    origin: Origin;
    targets: 'all' | string[];
    preferHost?: string;
    payload: Record<string, unknown>;
    createdAt: Time;
    deliveries?: Delivery[];
    [other: string]: unknown;
}

export type EndpointScope = 'loopback' | 'vpn' | 'public';

export interface EndpointAuth {
    kind: 'none' | 'bearer';
    keyEnv?: string;
}

export interface Endpoint {
    protocolVersion?: string;
    endpointId: string;
    type: string;
    url: string;
    scope: EndpointScope;
    quest: string;
    host: string;
    runtimeId: string;
    protocol?: string;
    auth: EndpointAuth;
    meta?: Record<string, unknown>;
    publishedAt: Time;
    [other: string]: unknown;
}

export interface Quota {
    maxGroups?: number;
    maxRuntimes?: number;
    maxResourcesPerLease?: number;
    maxActiveLeases?: number;
    callsPerHour?: number;
    messagesPerHour?: number;
    maxPayloadBytes?: number;
    maxStoredCommands?: number;
}

export interface GroupExport {
    formatVersion: number;
    group: Group;
    tokens: Record<string, number>;
    commands: Message[];
    runtimes: Runtime[];
}

export type Capability = 'runtimes' | 'sessions' | 'leases' | 'units' | 'messages' | 'endpoints' | 'migrate';

export interface HelloResult {
    protocolVersion: string;
    formatVersion: number;
    capabilities: Capability[];
    groups: string[];
    group?: Group;
    migratedTo?: BackendIdentity;
    service?: { name: string; version: string; pid: number; startedAt: Time };
}

export interface MisconfigurationWarning {
    kind: 'repositoryUnderTwoBackends' | 'groupWithTwoBackends' | 'cloneMissingOrMismatched';
    message: string;
    runtimes: string[];
    repository?: string;
    groupId?: string;
}

/** A frame on the stream (§ 9.3). */
export type StreamFrame =
    | { kind: 'notification' | 'command'; message: Message }
    | { kind: 'ack'; messageId: string; outcome: AckOutcome; reason?: string };
