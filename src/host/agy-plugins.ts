import { spawn, spawnSync } from 'node:child_process';
import { type HostServices } from './services.ts';

export interface PluginInfo {
    name: string;
    enabled: boolean;
    description: string;
}

export function listPlugins(services: HostServices): PluginInfo[] {
    const bin = services.bin();
    if (!bin) return [];
    try {
        const result = spawnSync(bin, ['plugin', 'list', '--json'], { encoding: 'utf-8' });
        if (result.status !== 0) return [];
        return JSON.parse(result.stdout) as PluginInfo[];
    } catch {
        return [];
    }
}

export async function toggleAgyPlugin(name: string, enabled: boolean, services: HostServices): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    const bin = services.bin();
    if (!bin) throw new Error('agy binary not found');
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, ['plugin', action, name]);
        proc.on('close', (code: number | null) => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to ${action} plugin ${name} (exit code ${code})`));
        });
    });
}
