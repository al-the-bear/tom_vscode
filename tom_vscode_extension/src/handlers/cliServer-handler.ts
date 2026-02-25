/**
 * Handler for CLI Integration Server commands.
 * 
 * Provides commands to start/stop the Tom CLI integration server,
 * allowing external CLI tools to communicate with VS Code via socket.
 */

import * as vscode from 'vscode';
import { getBridgeClient, bridgeLog } from './handler_shared';

/** Default port for CLI integration server (must match Dart side) */
const DEFAULT_CLI_SERVER_PORT = 19900;

/**
 * Response from CLI server start/stop commands
 */
interface CliServerResponse {
    success: boolean;
    message: string;
    port?: number;
    error?: string;
    alreadyRunning?: boolean;
    wasRunning?: boolean;
}

/**
 * Response from CLI server status command
 */
interface CliServerStatusResponse {
    running: boolean;
    port?: number;
}

/**
 * Get the current CLI server status.
 * Returns { running, port } or { running: false } if bridge not available.
 */
export async function getCliServerStatus(): Promise<CliServerStatusResponse> {
    const bridgeClient = getBridgeClient();
    if (!bridgeClient) {
        return { running: false };
    }

    try {
        const response = await bridgeClient.sendRequest<CliServerStatusResponse>('getCliServerStatus');
        return response;
    } catch (error) {
        bridgeLog(`Failed to get CLI server status: ${error}`, 'ERROR');
        return { running: false };
    }
}

/**
 * Start the CLI integration server on auto-selected port (19900-19909)
 * The Dart bridge will find an available port starting from 19900.
 */
export async function startCliServerHandler(): Promise<void> {
    await startCliServerWithPort(undefined);
}

/**
 * Start the CLI integration server with a custom port (prompts user)
 */
export async function startCliServerCustomPortHandler(): Promise<void> {
    const portString = await vscode.window.showInputBox({
        prompt: 'Enter port number for CLI integration server',
        value: DEFAULT_CLI_SERVER_PORT.toString(),
        validateInput: (value) => {
            const port = parseInt(value, 10);
            if (isNaN(port) || port < 1 || port > 65535) {
                return 'Please enter a valid port number (1-65535)';
            }
            return null;
        }
    });

    if (portString === undefined) {
        // User cancelled
        return;
    }

    const port = parseInt(portString, 10);
    await startCliServerWithPort(port);
}

/**
 * Stop the CLI integration server
 */
export async function stopCliServerHandler(): Promise<void> {
    const bridgeClient = getBridgeClient();
    if (!bridgeClient) {
        vscode.window.showErrorMessage('VS Code Bridge is not running');
        return;
    }

    try {
        const response = await bridgeClient.sendRequest<CliServerResponse>('stopCliServer');

        if (response.success) {
            if (response.wasRunning) {
                vscode.window.showInformationMessage(`Tom CLI integration server stopped`);
            } else {
                vscode.window.showInformationMessage('Tom CLI integration server was not running');
            }
        } else {
            vscode.window.showErrorMessage(`Failed to stop CLI server: ${response.message}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bridgeLog(`Failed to stop CLI server: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`Failed to stop CLI server: ${message}`);
    }
}

/**
 * Internal helper to start the CLI server on a specific port or auto-select
 */
async function startCliServerWithPort(port: number | undefined): Promise<void> {
    const bridgeClient = getBridgeClient();
    if (!bridgeClient) {
        vscode.window.showErrorMessage('VS Code Bridge is not running');
        return;
    }

    try {
        // Only include port in params if explicitly specified
        const params = port !== undefined ? { port } : {};
        const response = await bridgeClient.sendRequest<CliServerResponse>('startCliServer', params);

        if (response.success) {
            if (response.alreadyRunning) {
                vscode.window.showInformationMessage(`Tom CLI integration server already running on port ${response.port}`);
            } else {
                vscode.window.showInformationMessage(`Tom CLI integration server started on port ${response.port}`);
            }
        } else {
            if (response.error === 'PORT_IN_USE') {
                vscode.window.showErrorMessage(`Port ${port} is already in use. Try a different port.`);
            } else if (response.error === 'NO_PORT_AVAILABLE') {
                vscode.window.showErrorMessage('No available ports in range 19900-19909. Stop other bridge servers or use a custom port.');
            } else {
                vscode.window.showErrorMessage(`Failed to start CLI server: ${response.message}`);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bridgeLog(`Failed to start CLI server: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`Failed to start CLI server: ${message}`);
    }
}
