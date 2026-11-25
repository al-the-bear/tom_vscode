/**
 * The queue's health check: whether the drain is due.
 */

export interface HealthCheckInput {
    autoSendEnabled: boolean;
    pendingCount: number;
    sendingCount: number;
    /** Queue per run on: whether a lane could start an item now (decides the drain instead of the sending count). */
    laneStartPossible?: boolean;
}

export interface HealthCheckDecisions {
    shouldTriggerSendNext: boolean;
}

export function computeHealthCheckDecisions(input: HealthCheckInput): HealthCheckDecisions {
    // With lanes (Queue per run) one lane can be idle while another sends: then the drain is due when an item could start.
    const shouldTriggerSendNext =
        input.autoSendEnabled &&
        (input.laneStartPossible !== undefined
            ? input.laneStartPossible
            : input.pendingCount > 0 && input.sendingCount === 0);
    return { shouldTriggerSendNext };
}
