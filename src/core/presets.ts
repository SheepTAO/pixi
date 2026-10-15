import { DEFAULT_CONDA_CHANNEL } from './projectDiscovery';

export interface CondaChannelPreset {
    label: string;
    description: string;
    channel?: string;
}

export interface CondaPlatformPreset {
    name: string;
    description: string;
}

export interface ManifestPresetCompletionItem {
    label: string;
    detail: string;
}

export const CONDA_CHANNEL_PRESETS: readonly CondaChannelPreset[] = [
    {
        label: `$(server) ${DEFAULT_CONDA_CHANNEL} (default)`,
        description: 'Community-driven Conda repository (default)',
        channel: DEFAULT_CONDA_CHANNEL,
    },
    {
        label: `$(rocket) Tsinghua Mirror (${DEFAULT_CONDA_CHANNEL})`,
        description: `https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/${DEFAULT_CONDA_CHANNEL}`,
        channel: `https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/${DEFAULT_CONDA_CHANNEL}`,
    },
    {
        label: `$(rocket) BFSU Mirror (${DEFAULT_CONDA_CHANNEL})`,
        description: `https://mirrors.bfsu.edu.cn/anaconda/cloud/${DEFAULT_CONDA_CHANNEL}`,
        channel: `https://mirrors.bfsu.edu.cn/anaconda/cloud/${DEFAULT_CONDA_CHANNEL}`,
    },
    {
        label: `$(rocket) Aliyun Mirror (${DEFAULT_CONDA_CHANNEL})`,
        description: `https://mirrors.aliyun.com/anaconda/cloud/${DEFAULT_CONDA_CHANNEL}`,
        channel: `https://mirrors.aliyun.com/anaconda/cloud/${DEFAULT_CONDA_CHANNEL}`,
    },
    {
        label: '$(server) pytorch',
        description: 'Official PyTorch Conda channel',
        channel: 'pytorch',
    },
    {
        label: '$(server) nvidia',
        description: 'Official NVIDIA CUDA packages channel',
        channel: 'nvidia',
    },
    {
        label: '$(beaker) bioconda',
        description: 'Bioinformatics and biology package channel',
        channel: 'bioconda',
    },
    {
        label: '$(server) robostack',
        description: 'ROS and robotics packages channel',
        channel: 'robostack',
    },
    {
        label: '$(server) node-forge',
        description: 'NodeJS ecosystem Conda channel',
        channel: 'node-forge',
    },
];

export const COMMON_CHANNELS: readonly ManifestPresetCompletionItem[] = CONDA_CHANNEL_PRESETS.filter(
    (p) => p.channel && !p.channel.startsWith('http'),
).map((p) => ({ label: p.channel!, detail: p.description }));

export const CONDA_PLATFORM_PRESETS: readonly CondaPlatformPreset[] = [
    { name: 'linux-64', description: 'Linux x86_64 architecture' },
    { name: 'linux-aarch64', description: 'Linux ARM64 / aarch64 architecture' },
    { name: 'osx-arm64', description: 'macOS Apple Silicon (M1/M2/M3/M4)' },
    { name: 'osx-64', description: 'macOS Intel x86_64 architecture' },
    { name: 'win-64', description: 'Windows x86_64 architecture' },
    { name: 'win-arm64', description: 'Windows ARM64 architecture' },
];

export const COMMON_PLATFORMS: readonly ManifestPresetCompletionItem[] = [
    ...CONDA_PLATFORM_PRESETS.map((p) => ({ label: p.name, detail: p.description })),
    { label: 'noarch', detail: 'Platform-independent Conda packages' },
];
