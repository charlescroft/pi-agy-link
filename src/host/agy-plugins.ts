import { spawn } from 'node:child_process';
import { type HostServices } from './services.ts';

export async function toggleAgyPlugin(name: string, enabled: boolean, services: HostServices): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    const bin = services.bin();
    if (!bin) throw new Error('agy binary not found');
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, ['plugin', action, name]);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to ${action} plugin ${name} (exit code ${code})`));
        });
    });
}
