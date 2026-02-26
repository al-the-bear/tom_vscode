import * as fs from 'fs';
import * as path from 'path';
import { parse, stringify } from 'yaml';

export class FsUtils {
    static ensureDir(dirPath: string): void {
        if (!dirPath) {
            return;
        }
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    static safeReadFile(filePath: string): string | undefined {
        try {
            if (!fs.existsSync(filePath)) {
                return undefined;
            }
            return fs.readFileSync(filePath, 'utf-8');
        } catch {
            return undefined;
        }
    }

    static safeReadJson<T>(filePath: string): T | undefined {
        try {
            const content = this.safeReadFile(filePath);
            if (!content) {
                return undefined;
            }
            return JSON.parse(content) as T;
        } catch {
            return undefined;
        }
    }

    static safeWriteJson(filePath: string, data: unknown, indent = 2): void {
        this.ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(data, null, indent), 'utf-8');
    }

    static safeReadYaml<T>(filePath: string): T | undefined {
        try {
            const content = this.safeReadFile(filePath);
            if (!content) {
                return undefined;
            }
            return parse(content) as T;
        } catch {
            return undefined;
        }
    }

    static safeWriteYaml(filePath: string, data: unknown): void {
        this.ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, stringify(data), 'utf-8');
    }

    static fileExists(filePath: string): boolean {
        return fs.existsSync(filePath);
    }

    static listFiles(dirPath: string, pattern?: string): string[] {
        if (!fs.existsSync(dirPath)) {
            return [];
        }
        const files = fs.readdirSync(dirPath)
            .map((name) => path.join(dirPath, name))
            .filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile());

        if (!pattern || !pattern.trim()) {
            return files;
        }

        const trimmed = pattern.trim();
        if (trimmed.includes('*')) {
            const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            const regex = new RegExp(`^${escaped}$`, 'i');
            return files.filter((file) => regex.test(path.basename(file)));
        }

        return files.filter((file) => path.basename(file).includes(trimmed));
    }
}
