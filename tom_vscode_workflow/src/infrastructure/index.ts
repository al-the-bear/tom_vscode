/**
 * TOM Tracker — Infrastructure Module Index
 *
 * Central re-exports for all infrastructure components.
 */

// Logger
export {
    type LogLevel,
    type LoggerConfig,
    initLogger,
    disposeLogger,
    configureLogger,
    getLogChannel,
    getDebugLogChannel,
    showLog,
    showDebugLog,
    log,
    debug,
    warn,
    error,
} from './logger';

// Error Capture
export {
    type ErrorReport,
    type ErrorCallback,
    onError,
    reportError,
    wrapCommand,
    wrapListener,
    wrapWebviewProvider,
    safeDispose,
    installGlobalErrorHandlers,
} from './errorCapture';
