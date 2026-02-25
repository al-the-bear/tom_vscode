import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        globals: true,
    },
    resolve: {
        alias: {
            // Mock the vscode module for testing outside VS Code
            vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
        },
    },
});
