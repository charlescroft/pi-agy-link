import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type HostServices } from './services.ts';

const AGY_TOOL_REPO_URL = 'https://github.com/justhil/agy-tool.git';

function resolveLocalPluginDir(name: string): string {
    const repoDir = join(homedir(), '.pi', 'agent', 'agy-tool');
    const pluginDir = join(repoDir, 'plugins', name);
    if (!existsSync(repoDir)) {
        const clone = spawnSync('git', ['clone', '--depth', '1', AGY_TOOL_REPO_URL, repoDir], { encoding: 'utf-8' });
        if (clone.status !== 0) {
            const msg = (clone.stderr || clone.stdout || '').trim();
            throw new Error(msg || `git clone agy-tool failed with ${clone.status}`);
        }
    } else if (!existsSync(pluginDir)) {
        spawnSync('git', ['-C', repoDir, 'pull', '--ff-only'], { encoding: 'utf-8' });
    }
    if (!existsSync(pluginDir)) {
        throw new Error(`Plugin directory not found: ${pluginDir}`);
    }
    return pluginDir;
}

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
        const pluginDir = resolveLocalPluginDir(name);
        const inst = spawnSync(bin, ['plugin', 'install', pluginDir], { encoding: 'utf-8' });
        if (inst.status !== 0) {
            const msg = (inst.stderr || inst.stdout || '').trim();
            throw new Error(msg || `agy plugin install exited with ${inst.status}`);
        }
        const en = spawnSync(bin, ['plugin', 'enable', name], { encoding: 'utf-8' });
        if (en.status !== 0) {
            const msg = (en.stderr || en.stdout || '').trim();
            throw new Error(msg || `agy plugin enable exited with ${en.status}`);
        }
    } else {
        // 关闭时直接 uninstall，彻底从 agy-cli 环境中移除
        const un = spawnSync(bin, ['plugin', 'uninstall', name], { encoding: 'utf-8' });
        if (un.status !== 0) {
            const msg = (un.stderr || un.stdout || '').trim();
            throw new Error(msg || `agy plugin uninstall exited with ${un.status}`);
        }
    }
}
