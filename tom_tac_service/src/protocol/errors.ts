/** The TAC error codes (doc/tac_specification.md § 7). */

export type TacErrorCode =
    | 'conflict'
    | 'staleToken'
    | 'notHolder'
    | 'quotaExceeded'
    | 'versionMismatch'
    | 'unsupported'
    | 'migrated'
    | 'notFound'
    | 'invalid'
    | 'unauthorized'
    | 'unavailable'
    // client only
    | 'unreachable'
    | 'busy';

/** The HTTP status of each wire error code (§ 7, § 9.4). */
export const HTTP_STATUS: Record<TacErrorCode, number> = {
    conflict: 409,
    staleToken: 412,
    notHolder: 403,
    quotaExceeded: 429,
    versionMismatch: 426,
    unsupported: 501,
    migrated: 410,
    notFound: 404,
    invalid: 400,
    unauthorized: 401,
    unavailable: 503,
    unreachable: 0,
    busy: 0,
};

export interface TacErrorBody {
    code: TacErrorCode;
    message: string;
    details?: Record<string, unknown>;
}

export class TacError extends Error {
    constructor(
        readonly code: TacErrorCode,
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'TacError';
    }

    toBody(): TacErrorBody {
        return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
    }

    get httpStatus(): number {
        return HTTP_STATUS[this.code] || 500;
    }
}
