import { spawnSync } from 'node:child_process';
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

export async function manageAgyPlugin(name: string, enable: boolean, services: HostServices): Promise<void> {
    const bin = services.bin();
    if (!bin) throw new Error('agy binary not found');
    
    // 如果启用但未安装，先安装
    if (enable) {
        spawnSync(bin, ['plugin', 'install', `justhil/agy-tool/plugins/${name}`]);
        spawnSync(bin, ['plugin', 'enable', name]);
    } else {
        // 关闭时直接 uninstall，彻底从 agy-cli 环境中移除
        spawnSync(bin, ['plugin', 'uninstall', name]);
    }
}
