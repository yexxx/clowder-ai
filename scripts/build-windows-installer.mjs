import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, win32 } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const DEFAULT_WEBVIEW2_VERSION = process.env.CLOWDER_WEBVIEW2_VERSION ?? '1.0.3856.49';
const WINDOWS_RUNTIME_NPM_ARGS = [
  'install',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  '--loglevel=error',
];

export const WINDOWS_PRESERVE_PATHS = ['.env', 'cat-config.json', 'data', 'logs', '.cat-cafe'];
export const WINDOWS_MANAGED_TOP_LEVEL_PATHS = [
  'packages',
  'scripts',
  'cat-cafe-skills',
  'tools',
  'installer-seed',
  'vendor',
  '.clowder-release.json',
  '.env.example',
  'LICENSE',
  'cat-template.json',
  'modelarts-preset.json',
  'pnpm-workspace.yaml',
];

const EXCLUDED_TOP_LEVEL_SEGMENTS = new Set(['.git', 'node_modules']);
const EXCLUDED_EXACT_PATHS = new Set([
  '.env',
  'data',
  'logs',
  'dist',
  'packages/api/dist',
  'packages/mcp-server/dist',
  'packages/web/.next',
]);
const EXCLUDED_PREFIXES = [
  'data/',
  'logs/',
  'dist/',
  'packages/api/dist/',
  'packages/mcp-server/dist/',
  'packages/web/.next/',
];
const RUNTIME_SCRIPT_FILES = [
  'install-auth-config.mjs',
  'install-windows-helpers.ps1',
  'restart-windows.ps1',
  'restart.bat',
  'start-entry.mjs',
  'start-windows.ps1',
  'start.bat',
  'stop-windows.ps1',
  'windows-command-helpers.ps1',
  'windows-installer-ui.ps1',
];
const PYTHON_EMBED_VERSION = '3.13.4';
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_EMBED_VERSION}/python-${PYTHON_EMBED_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const PYTHON_MAJOR_MINOR = PYTHON_EMBED_VERSION.split('.').slice(0, 2).join('');
const WEB_STANDALONE_BUILD_DIR = join(repoRoot, 'packages', 'web', '.next', 'standalone');
const WEB_STANDALONE_APP_DIR = join(WEB_STANDALONE_BUILD_DIR, 'packages', 'web');
const WEB_STANDALONE_NODE_MODULES_DIR = join(WEB_STANDALONE_BUILD_DIR, 'node_modules');
const WEB_BUILD_STATIC_DIR = join(repoRoot, 'packages', 'web', '.next', 'static');
const WEB_PUBLIC_DIR = join(repoRoot, 'packages', 'web', 'public');
const ROOT_NODE_MODULES_DIR = join(repoRoot, 'node_modules');
const API_RUNTIME_EXTERNAL_DEPENDENCIES = [
  'better-sqlite3',
  'node-pty',
  'pino',
  'pino-roll',
  'puppeteer',
  'sharp',
  'sqlite-vec',
];
const WEB_RUNTIME_DEPENDENCIES = ['next', 'react', 'react-dom', 'sharp'];
const RUNTIME_WEB_STANDALONE_SERVER = `const fs = require('node:fs');
const path = require('node:path');

function resolveApiBaseUrl() {
  const explicit = process.env.NEXT_PUBLIC_API_URL?.replace(/\\/+$/, '');
  if (explicit) return explicit;

  const apiPort = Number(process.env.API_SERVER_PORT);
  if (Number.isInteger(apiPort) && apiPort > 0) {
    return \`http://localhost:\${apiPort}\`;
  }

  const frontendPort = Number(process.env.FRONTEND_PORT);
  if (Number.isInteger(frontendPort) && frontendPort > 0) {
    return \`http://localhost:\${frontendPort + 1}\`;
  }

  return 'http://localhost:3004';
}

const dir = __dirname;

process.env.NODE_ENV = 'production';
process.chdir(__dirname);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';

let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);

const requiredServerFiles = JSON.parse(
  fs.readFileSync(path.join(__dirname, '.next', 'required-server-files.json'), 'utf8'),
);
const nextConfig = requiredServerFiles.config || {};
const rewrites = nextConfig._originalRewrites || {};
const afterFiles = Array.isArray(rewrites.afterFiles)
  ? rewrites.afterFiles.filter((entry) => entry && entry.source !== '/uploads/:path*')
  : [];

nextConfig._originalRewrites = {
  beforeFiles: Array.isArray(rewrites.beforeFiles) ? rewrites.beforeFiles : [],
  afterFiles: [
    ...afterFiles,
    {
      source: '/uploads/:path*',
      destination: \`\${resolveApiBaseUrl()}/uploads/:path*\`,
    },
  ],
  fallback: Array.isArray(rewrites.fallback) ? rewrites.fallback : [],
};

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require('next');
const { startServer } = require('next/dist/server/lib/start-server');

if (
  Number.isNaN(keepAliveTimeout) ||
  !Number.isFinite(keepAliveTimeout) ||
  keepAliveTimeout < 0
) {
  keepAliveTimeout = undefined;
}

startServer({
  dir,
  isDev: false,
  config: nextConfig,
  hostname,
  port: currentPort,
  allowRetry: false,
  keepAliveTimeout,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

export function normalizeNodeVersion(version) {
  const trimmed = String(version ?? '').trim();
  if (!trimmed) {
    throw new Error('Windows Node version is empty');
  }
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export function pickRedisReleaseAsset(assets) {
  const candidates = [
    /^Redis-.*-Windows-x64-msys2\.zip$/i,
    /^Redis-.*-Windows-x64-cygwin\.zip$/i,
    /^Redis-.*-Windows-x64-msys2-with-Service\.zip$/i,
    /^Redis-.*-Windows-x64-cygwin-with-Service\.zip$/i,
  ];
  for (const pattern of candidates) {
    const asset = assets.find((entry) => pattern.test(entry.name ?? ''));
    if (asset) {
      return asset;
    }
  }
  return null;
}

export function shouldCopyRepoPath(relativePath) {
  const normalized = relativePath.split(sep).join('/');
  if (!normalized || normalized === '.') return true;
  const segments = normalized.split('/');
  if (segments.some((segment) => EXCLUDED_TOP_LEVEL_SEGMENTS.has(segment))) return false;
  if (EXCLUDED_EXACT_PATHS.has(normalized)) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function shouldUseCommandShell(command, platform = process.platform) {
  if (platform !== 'win32') return false;
  const normalized = String(command ?? '').trim();
  if (!normalized) return false;
  return !normalized.includes('/') && !normalized.includes('\\');
}

function parseArgs(argv) {
  const options = {
    bundleOnly: false,
    skipBuild: false,
    skipPython: false,
    launcherOnly: false,
    nsisOnly: false,
    outputDir: resolve(repoRoot, 'dist', 'windows'),
    cacheDir: null,
    nodeVersion: normalizeNodeVersion(process.env.CLOWDER_WINDOWS_NODE_VERSION ?? process.versions.node),
    nodeZipUrl: process.env.CLOWDER_WINDOWS_NODE_ZIP_URL ?? null,
    redisZipUrl: process.env.CLOWDER_WINDOWS_REDIS_ZIP_URL ?? null,
    webview2Version: DEFAULT_WEBVIEW2_VERSION,
    redisReleaseApi:
      process.env.CLOWDER_WINDOWS_REDIS_RELEASE_API ??
      'https://api.github.com/repos/redis-windows/redis-windows/releases/latest',
  };
  const handlers = new Map([
    [
      '--bundle-only',
      () => {
        options.bundleOnly = true;
        return 0;
      },
    ],
    [
      '--skip-build',
      () => {
        options.skipBuild = true;
        return 0;
      },
    ],
    [
      '--skip-python',
      () => {
        options.skipPython = true;
        return 0;
      },
    ],
    [
      '--launcher-only',
      () => {
        options.launcherOnly = true;
        return 0;
      },
    ],
    [
      '--nsis-only',
      () => {
        options.nsisOnly = true;
        return 0;
      },
    ],
    [
      '--output-dir',
      (value) => {
        options.outputDir = resolve(repoRoot, value ?? '');
        return 1;
      },
    ],
    [
      '--cache-dir',
      (value) => {
        options.cacheDir = resolve(repoRoot, value ?? '');
        return 1;
      },
    ],
    [
      '--node-version',
      (value) => {
        options.nodeVersion = normalizeNodeVersion(value ?? '');
        return 1;
      },
    ],
    [
      '--node-zip-url',
      (value) => {
        options.nodeZipUrl = value ?? null;
        return 1;
      },
    ],
    [
      '--redis-zip-url',
      (value) => {
        options.redisZipUrl = value ?? null;
        return 1;
      },
    ],
    [
      '--webview2-version',
      (value) => {
        options.webview2Version = value ?? options.webview2Version;
        return 1;
      },
    ],
    [
      '--redis-release-api',
      (value) => {
        options.redisReleaseApi = value ?? options.redisReleaseApi;
        return 1;
      },
    ],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    const handler = handlers.get(arg);
    if (!handler) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += handler(argv[index + 1]);
  }
  if (!options.cacheDir) {
    options.cacheDir = join(options.outputDir, 'cache');
  }
  return options;
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/build-windows-installer.mjs [options]

Options:
  --bundle-only         Build the offline bundle without invoking makensis
  --skip-build          Reuse existing dist/.next artifacts
  --skip-python         Skip Python embed download + pip install (reuse existing tools/python in bundle)
  --launcher-only       Rebuild only the C# desktop launcher into existing bundle, then stop
  --nsis-only           Skip bundle, only repackage existing bundle into exe
  --output-dir <path>   Override dist/windows output root
  --cache-dir <path>    Override download cache directory
  --node-version <ver>  Override bundled Windows Node version
  --node-zip-url <url>  Override Node zip URL
  --redis-zip-url <url> Override Redis zip URL
  --webview2-version <ver>
                        Override the WebView2 SDK version used for the desktop launcher build
  --redis-release-api <url>
                        Override Redis release metadata endpoint
`);
}

function logStep(message) {
  process.stdout.write(`\n[windows-installer] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? 'inherit',
    shell: options.shell ?? shouldUseCommandShell(command),
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runAndCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'pipe',
    shell: options.shell ?? shouldUseCommandShell(command),
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return (result.stdout ?? '').trim();
}

function commandExists(command) {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command);
  }
  const probeCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probeCommand, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveLocalEsbuildCommand() {
  const binCandidates =
    process.platform === 'win32'
      ? [
          join(ROOT_NODE_MODULES_DIR, '@esbuild', 'win32-x64', 'esbuild.exe'),
          join(ROOT_NODE_MODULES_DIR, '.bin', 'esbuild.cmd'),
          join(ROOT_NODE_MODULES_DIR, '.bin', 'esbuild'),
        ]
      : [join(ROOT_NODE_MODULES_DIR, '.bin', 'esbuild')];
  for (const candidate of binCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`esbuild executable not found in ${join(ROOT_NODE_MODULES_DIR, '.bin')}`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function toWindowsPath(path) {
  if (process.platform === 'win32') {
    return path;
  }
  if (!commandExists('wslpath')) {
    throw new Error('wslpath is required to build the Windows WebView2 launcher from Linux');
  }
  return runAndCapture('wslpath', ['-w', path]);
}

function toWslPath(path) {
  if (process.platform === 'win32') {
    return path;
  }
  if (!commandExists('wslpath')) {
    throw new Error('wslpath is required to access Windows staging paths from Linux');
  }
  return runAndCapture('wslpath', ['-u', path]);
}

function toNsisPath(path) {
  return path.replaceAll('\\', '/').replace(/\/?$/, '/');
}

function toNsisFilePath(path) {
  return path.replaceAll('\\', '/');
}

function toNsisDirPath(path) {
  return path.replaceAll('/', '\\').replace(/[\\/]+$/, '');
}

function copyEntry(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter(src) {
      const rel = relative(repoRoot, src);
      return shouldCopyRepoPath(rel);
    },
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createIcoFromPng(pngPath, icoPath) {
  const png = readFileSync(pngPath);
  const pngSignature = '89504e470d0a1a0a';
  if (png.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error(`Unsupported PNG icon source: ${pngPath}`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = width >= 256 ? 0 : width;
  header[7] = height >= 256 ? 0 : height;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  writeFileSync(icoPath, Buffer.concat([header, png]));
}

function copyTopLevelProject(bundleDir) {
  const entries = [
    'cat-cafe-skills',
    'LICENSE',
    '.env.example',
    'cat-template.json',
    'modelarts-preset.json',
    'pnpm-workspace.yaml',
  ];
  for (const entry of entries) {
    const source = join(repoRoot, entry);
    if (!existsSync(source)) {
      throw new Error(`Missing required bundle entry: ${source}`);
    }
    const destination = join(bundleDir, entry);
    ensureDir(dirname(destination));
    copyEntry(source, destination);
  }

  const scriptsDir = join(bundleDir, 'scripts');
  ensureDir(scriptsDir);
  for (const scriptName of RUNTIME_SCRIPT_FILES) {
    const source = join(repoRoot, 'scripts', scriptName);
    if (!existsSync(source)) {
      throw new Error(`Missing runtime script: ${source}`);
    }
    cpSync(source, join(scriptsDir, scriptName), { force: true });
  }
}

async function stageWindowsPython(bundleDir, options) {
  const archiveName = `python-${PYTHON_EMBED_VERSION}-embed-amd64.zip`;
  const archivePath = join(options.cacheDir, archiveName);
  await ensureCachedDownload(PYTHON_EMBED_URL, archivePath);

  const targetDir = join(bundleDir, 'tools', 'python');
  resetDir(targetDir);
  extractZip(archivePath, targetDir);

  // Keep vendor source trees off sys.path while pip bootstraps/installs.
  // Some local checkouts contain generated *.egg-info/*.dist-info metadata that
  // pip/importlib.metadata will eagerly parse, which breaks on Python 3.13.
  writePythonRuntimePth(targetDir, { includeVendorPaths: false });

  // Bootstrap pip
  const getPipPath = join(options.cacheDir, 'get-pip.py');
  await ensureCachedDownload(GET_PIP_URL, getPipPath);
  const pythonExe = join(targetDir, 'python.exe');
  run(pythonExe, [getPipPath, '--no-warn-script-location', '-q']);

  return { version: PYTHON_EMBED_VERSION, url: PYTHON_EMBED_URL };
}

function writePythonRuntimePth(targetDir, options = {}) {
  const pthFile = join(targetDir, `python${PYTHON_MAJOR_MINOR}._pth`);
  if (!existsSync(pthFile)) {
    return;
  }

  const pthLines = [`python${PYTHON_MAJOR_MINOR}.zip`, '.', 'Lib/site-packages'];
  if (options.includeVendorPaths) {
    pthLines.push('../../vendor/dare-cli', '../../vendor/jiuwenclaw');
  }
  pthLines.push('import site');

  writeFileSync(pthFile, `${pthLines.join('\n')}\n`, 'utf8');
}

function installSharedPythonDeps(bundleDir) {
  const pythonDir = join(bundleDir, 'tools', 'python');
  const pythonExe = join(pythonDir, 'python.exe');

  // Ensure setuptools is available (needed by some packages with pyproject.toml builds)
  run(pythonExe, ['-m', 'pip', 'install', '-q', '--no-warn-script-location', 'setuptools', 'wheel']);

  // Install DARE dependencies (from pyproject.toml, excluding test deps)
  const dareDeps = [
    'anthropic', 'langchain-openai', 'langchain-core',
    'httpx>=0.27.0', 'starlette>=0.37.0', 'uvicorn>=0.30.0', 'chromadb>=0.4.0',
  ];
  run(pythonExe, ['-m', 'pip', 'install', '-q', '--no-warn-script-location', ...dareDeps]);

  // Install JiuwenClaw core runtime deps explicitly, then the package itself with --no-deps
  // (avoids pulling heavy optional deps like telegram-bot, discord.py, dingtalk etc.)
  const jiuwenCoreDeps = [
    'psutil>=7.0', 'loguru>=0.7', 'ruamel.yaml>=0.18', 'python-dotenv>=1.0',
    'websockets>=12.0', 'aiosqlite>=0.22', 'croniter>=2.0', 'mutagen>=1.47',
    'greenlet>=3.0', 'openjiuwen==0.1.7',
  ];
  run(pythonExe, ['-m', 'pip', 'install', '-q', '--no-warn-script-location', ...jiuwenCoreDeps]);
  const jiuwenClawDir = join(repoRoot, 'vendor', 'jiuwenclaw');
  run(pythonExe, ['-m', 'pip', 'install', '-q', '--no-warn-script-location', '--no-deps', jiuwenClawDir]);

  // Install office automation libraries for MCP servers
  const officeDeps = [
    'python-pptx',   // PowerPoint read/write
    'openpyxl',      // Excel read/write
    'python-docx',   // Word read/write
    'xlsxwriter',    // Excel write (fast, chart support)
    'pypdf',         // PDF read/merge/split
    'reportlab',     // PDF creation
    'markitdown',    // Microsoft multi-format → Markdown converter
  ];
  run(pythonExe, ['-m', 'pip', 'install', '-q', '--no-warn-script-location', ...officeDeps]);

  // Install agent-teams CLI for ACP multi-agent orchestration
  run(pythonExe, ['-m', 'pip', 'install', '-q', '--no-warn-script-location', 'cool-play-agent-teams']);

  // Prune site-packages to reduce size
  const sitePackages = join(bundleDir, 'tools', 'python', 'Lib', 'site-packages');
  removeNamedDirectoriesRecursive(sitePackages, ['tests', 'test', '__tests__']);
  walkFiles(sitePackages, (fullPath, entry) => {
    if (entry.name.endsWith('.pyo')) {
      rmSync(fullPath, { force: true });
    }
  });

  // Restore vendor source paths for runtime module launches after pip work is done.
  writePythonRuntimePth(pythonDir, { includeVendorPaths: true });
}

function stageVendorPythonSources(bundleDir) {
  const excludeDirs = new Set([
    'dist',
    '.venv',
    '.build-venv',
    'tests',
    'test',
    '.git',
    'node_modules',
    'build',
    '.mypy_cache',
    '.pytest_cache',
  ]);
  const excludeFiles = new Set(['uv.lock', 'PKG-INFO', 'METADATA']);

  function copySourceTree(srcDir, destDir) {
    ensureDir(destDir);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        if (entry.name.endsWith('.egg-info') || entry.name.endsWith('.dist-info')) continue;
        copySourceTree(srcPath, destPath);
      } else {
        if (excludeFiles.has(entry.name)) continue;
        if (entry.name.endsWith('.pyo')) continue;
        // Use copyFileSync instead of cpSync — cpSync fails on non-ASCII filenames on Windows
        copyFileSync(srcPath, destPath);
      }
    }
  }

  const vendorDir = join(bundleDir, 'vendor');
  ensureDir(vendorDir);
  copySourceTree(join(repoRoot, 'vendor', 'dare-cli'), join(vendorDir, 'dare-cli'));
  copySourceTree(join(repoRoot, 'vendor', 'jiuwenclaw'), join(vendorDir, 'jiuwenclaw'));
}

function stageInstallerSeed(bundleDir) {
  const seedDir = join(bundleDir, 'installer-seed');
  ensureDir(seedDir);
  const catConfigPath = join(repoRoot, 'cat-config.json');
  if (existsSync(catConfigPath)) {
    cpSync(catConfigPath, join(seedDir, 'cat-config.json'), { force: true });
  }
}

function copyIfPresent(source, destination) {
  if (!existsSync(source)) {
    return;
  }
  ensureDir(dirname(destination));
  cpSync(source, destination, { recursive: true, force: true });
}

function walkFiles(rootDir, visitor) {
  if (!existsSync(rootDir)) {
    return;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      visitor(fullPath, entry);
    }
  }
}

function removePaths(rootDir, relativePaths) {
  for (const relativePath of relativePaths) {
    rmSync(join(rootDir, relativePath), { recursive: true, force: true });
  }
}

function removeNamedDirectoriesRecursive(rootDir, directoryNames) {
  if (!existsSync(rootDir)) {
    return;
  }
  const names = new Set(directoryNames);
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullPath = join(current, entry.name);
      if (names.has(entry.name)) {
        rmSync(fullPath, { recursive: true, force: true });
        continue;
      }
      stack.push(fullPath);
    }
  }
}

function pruneRuntimePackage(targetDir, options = {}) {
  removePaths(targetDir, options.removePaths ?? []);
  removeNamedDirectoriesRecursive(targetDir, ['test', 'tests', '__tests__', 'example', 'examples', 'doc', 'docs']);
  walkFiles(targetDir, (fullPath, entry) => {
    const fileName = entry.name;
    if (fileName === 'package-lock.json' || fileName === '.package-lock.json') {
      rmSync(fullPath, { force: true });
      return;
    }
    if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.ts.map') || fileName.endsWith('.map')) {
      rmSync(fullPath, { force: true });
      return;
    }
    if (fileName.endsWith('.ts') || fileName.endsWith('.cts') || fileName.endsWith('.mts')) {
      rmSync(fullPath, { force: true });
      return;
    }
    if (fileName.endsWith('.md') || fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
      rmSync(fullPath, { force: true });
      return;
    }
    if (/^(README|CHANGELOG|CONTRIBUTING)(\..+)?$/i.test(fileName)) {
      rmSync(fullPath, { force: true });
      return;
    }
    if (/^\.(eslintrc|prettierrc|editorconfig|babelrc)/i.test(fileName)) {
      rmSync(fullPath, { force: true });
    }
  });
}

function pruneNativePrebuilds(rootDir) {
  if (!existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(current, entry.name);
      if (entry.name === 'prebuilds') {
        for (const platform of readdirSync(fullPath, { withFileTypes: true })) {
          if (!platform.isDirectory()) continue;
          if (!platform.name.startsWith('win32-x64')) {
            rmSync(join(fullPath, platform.name), { recursive: true, force: true });
          }
        }
        continue;
      }
      stack.push(fullPath);
    }
  }
}

function pruneDateFnsLocales(rootDir) {
  const localeDir = join(rootDir, 'date-fns', 'locale');
  if (!existsSync(localeDir)) return;
  const keepPrefixes = ['en-US', 'zh-CN', '_lib', 'types', 'cdn'];
  for (const entry of readdirSync(localeDir, { withFileTypes: true })) {
    const name = entry.name.replace(/\.(js|cjs|mjs)$/, '');
    if (keepPrefixes.some((p) => name === p)) continue;
    rmSync(join(localeDir, entry.name), { recursive: true, force: true });
  }
}

function createRuntimePackageJson(sourcePath, options = {}) {
  const source = readJson(sourcePath);
  const runtimePackage = {
    name: source.name,
    version: source.version,
    private: source.private ?? true,
  };

  for (const key of ['type', 'main', 'bin', 'exports', 'types']) {
    if (source[key] !== undefined) {
      runtimePackage[key] = source[key];
    }
  }

  if (options.scripts) {
    runtimePackage.scripts = options.scripts;
  } else if (source.scripts?.start) {
    runtimePackage.scripts = { start: source.scripts.start };
  }

  const dependencies = { ...(source.dependencies ?? {}) };
  if (dependencies['@cat-cafe/shared']) {
    dependencies['@cat-cafe/shared'] = 'file:../shared';
  }
  if (Object.keys(dependencies).length > 0) {
    runtimePackage.dependencies = dependencies;
  }

  if (source.optionalDependencies && Object.keys(source.optionalDependencies).length > 0) {
    runtimePackage.optionalDependencies = source.optionalDependencies;
  }

  return runtimePackage;
}

function createBundledApiRuntimePackageJson(sourcePath) {
  const source = readJson(sourcePath);
  const runtimePackage = createRuntimePackageJson(sourcePath, {
    scripts: {
      start: 'node dist/index.js',
    },
  });
  const runtimeDependencies = Object.fromEntries(
    API_RUNTIME_EXTERNAL_DEPENDENCIES.flatMap((dependency) => {
      const sourceVersion = source.dependencies?.[dependency];
      if (sourceVersion) {
        return [[dependency, sourceVersion]];
      }
      const installedVersion = resolveInstalledPackageVersion(ROOT_NODE_MODULES_DIR, dependency);
      return installedVersion ? [[dependency, installedVersion]] : [];
    }),
  );
  if (Object.keys(runtimeDependencies).length > 0) {
    runtimePackage.dependencies = runtimeDependencies;
  } else {
    delete runtimePackage.dependencies;
  }
  delete runtimePackage.optionalDependencies;
  return runtimePackage;
}

function resolveInstalledPackageVersion(nodeModulesDir, packageName) {
  const packageJsonPath = join(nodeModulesDir, packageName, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  const installed = readJson(packageJsonPath);
  return typeof installed.version === 'string' && installed.version.trim().length > 0 ? installed.version.trim() : null;
}

function createStandaloneWebRuntimePackageJson(sourcePath) {
  const source = readJson(sourcePath);
  const runtimePackage = createRuntimePackageJson(sourcePath, {
    scripts: {
      start: 'node server.js',
    },
  });
  const runtimeDependencies = Object.fromEntries(
    WEB_RUNTIME_DEPENDENCIES.flatMap((dependency) => {
      const sourceVersion = source.dependencies?.[dependency];
      if (sourceVersion) {
        return [[dependency, sourceVersion]];
      }
      const installedVersion = resolveInstalledPackageVersion(WEB_STANDALONE_NODE_MODULES_DIR, dependency);
      return installedVersion ? [[dependency, installedVersion]] : [];
    }),
  );
  if (Object.keys(runtimeDependencies).length > 0) {
    runtimePackage.dependencies = runtimeDependencies;
  } else {
    delete runtimePackage.dependencies;
  }
  delete runtimePackage.optionalDependencies;
  return runtimePackage;
}

function stageRuntimePackageTemplate(targetRootDir, packageName, config) {
  const sourceDir = join(repoRoot, 'packages', packageName);
  const targetDir = join(targetRootDir, 'packages', packageName);
  resetDir(targetDir);
  for (const relativePath of config.copyPaths) {
    copyIfPresent(join(sourceDir, relativePath), join(targetDir, relativePath));
  }
  writeJson(join(targetDir, 'package.json'), createRuntimePackageJson(join(sourceDir, 'package.json'), config));
  if (config.writeFiles) {
    for (const [relativePath, content] of Object.entries(config.writeFiles)) {
      writeFileSync(join(targetDir, relativePath), content, 'utf8');
    }
  }
  pruneRuntimePackage(targetDir, { removePaths: config.removePaths ?? [] });
}

async function stageBundledApiRuntime(targetRootDir) {
  const sourceDir = join(repoRoot, 'packages', 'api');
  const sourceEntry = join(sourceDir, 'dist', 'index.js');
  const targetDir = join(targetRootDir, 'packages', 'api');
  if (!existsSync(sourceEntry)) {
    throw new Error(`Missing API build artifact for bundling: ${sourceEntry}`);
  }

  resetDir(targetDir);
  ensureDir(join(targetDir, 'dist'));

  try {
    const esbuildCommand = resolveLocalEsbuildCommand();
    const banner = [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { dirname as __pathDirname } from 'node:path';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join(' ');
    run(esbuildCommand, [
      sourceEntry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node20',
      `--outfile=${join(targetDir, 'dist', 'index.js')}`,
      `--banner:js=${banner}`,
      '--log-level=error',
      ...API_RUNTIME_EXTERNAL_DEPENDENCIES.map((dependency) => `--external:${dependency}`),
    ]);

    writeJson(join(targetDir, 'package.json'), createBundledApiRuntimePackageJson(join(sourceDir, 'package.json')));
  } catch (error) {
    logStep(
      `API bundling unavailable, falling back to staged dist (${error instanceof Error ? error.message : String(error)})`,
    );
    copyIfPresent(join(sourceDir, 'dist'), join(targetDir, 'dist'));
    writeJson(
      join(targetDir, 'package.json'),
      createRuntimePackageJson(join(sourceDir, 'package.json'), {
        scripts: {
          start: 'node dist/index.js',
        },
      }),
    );
  }
  pruneRuntimePackage(targetDir, { removePaths: ['src', 'test', 'scripts', 'uploads', 'tsconfig.json'] });
}

function stageStandaloneWebRuntime(targetRootDir) {
  const sourceDir = join(repoRoot, 'packages', 'web');
  const targetDir = join(targetRootDir, 'packages', 'web');
  const standaloneServerPath = join(WEB_STANDALONE_APP_DIR, 'server.js');
  if (!existsSync(standaloneServerPath)) {
    resetDir(targetDir);
    copyIfPresent(join(sourceDir, '.next'), join(targetDir, '.next'));
    copyIfPresent(WEB_PUBLIC_DIR, join(targetDir, 'public'));
    copyIfPresent(join(sourceDir, 'next.config.js'), join(targetDir, 'next.config.js'));
    writeJson(
      join(targetDir, 'package.json'),
      createRuntimePackageJson(join(sourceDir, 'package.json'), {
        scripts: {
          start: 'next start',
        },
      }),
    );
    pruneRuntimePackage(targetDir, {
      removePaths: [
        'src',
        'test',
        'worker',
        '.next/cache',
        '.next/standalone',
        '.next/types',
        '.eslintrc.json',
        'next-env.d.ts',
        'postcss.config.js',
        'tailwind.config.js',
        'tsconfig.json',
        'vitest.config.ts',
      ],
    });
    return;
  }
  if (!existsSync(WEB_STANDALONE_NODE_MODULES_DIR)) {
    throw new Error(`Missing Next standalone node_modules: ${WEB_STANDALONE_NODE_MODULES_DIR}`);
  }

  resetDir(targetDir);
  cpSync(WEB_STANDALONE_APP_DIR, targetDir, { recursive: true, force: true });
  rmSync(join(targetDir, 'node_modules'), { recursive: true, force: true });
  copyIfPresent(WEB_BUILD_STATIC_DIR, join(targetDir, '.next', 'static'));
  copyIfPresent(WEB_PUBLIC_DIR, join(targetDir, 'public'));
  writeJson(
    join(targetDir, 'package.json'),
    createStandaloneWebRuntimePackageJson(join(repoRoot, 'packages', 'web', 'package.json')),
  );
  writeFileSync(join(targetDir, 'server.js'), RUNTIME_WEB_STANDALONE_SERVER, 'utf8');
  pruneRuntimePackage(targetDir, {
    removePaths: [
      'src',
      'test',
      'worker',
      '.next/cache',
      '.next/types',
      '.eslintrc.json',
      'next-env.d.ts',
      'postcss.config.js',
      'tailwind.config.js',
      'tsconfig.json',
      'vitest.config.ts',
    ],
  });
}

function getWindowsTempPath() {
  return runAndCapture('powershell.exe', ['-NoProfile', '-Command', '[IO.Path]::GetTempPath()']);
}

function ensureWindowsBuildNode(options) {
  const windowsTemp = getWindowsTempPath();
  const windowsNodeDir = win32.join(windowsTemp, `clowder-node-${options.nodeVersion}`);
  const windowsNodeWslDir = toWslPath(windowsNodeDir);
  const nodeRootName = `node-${options.nodeVersion}-win-x64`;
  const npmCmdPath = win32.join(windowsNodeDir, nodeRootName, 'npm.cmd');
  if (!existsSync(toWslPath(npmCmdPath))) {
    resetDir(windowsNodeWslDir);
    const archivePath = join(options.cacheDir, `node-${options.nodeVersion}-win-x64.zip`);
    extractZip(archivePath, windowsNodeWslDir);
  }
  return {
    windowsNodeDir,
    npmCmdPath,
  };
}

function runWindowsNpmInstall(npmCmdPath, packageWindowsDir) {
  run(npmCmdPath, WINDOWS_RUNTIME_NPM_ARGS, { cwd: packageWindowsDir, shell: true });
}

function materializeSharedDependency(stagePackagesDir, packageName) {
  const sharedLinkPath = join(stagePackagesDir, packageName, 'node_modules', '@cat-cafe', 'shared');
  try {
    if (!lstatSync(sharedLinkPath).isSymbolicLink()) {
      return;
    }
  } catch {
    return;
  }
  rmSync(sharedLinkPath, { recursive: true, force: true });
  cpSync(join(stagePackagesDir, 'shared'), sharedLinkPath, { recursive: true, force: true });
  pruneRuntimePackage(sharedLinkPath);
}

async function installWindowsRuntimeDependencies(bundleDir, options) {
  const bundlePackagesDir = join(bundleDir, 'packages');
  const windowsNode = ensureWindowsBuildNode(options);

  for (const packageName of ['api', 'mcp-server', 'web']) {
    runWindowsNpmInstall(windowsNode.npmCmdPath, toWindowsPath(join(bundlePackagesDir, packageName)));
    materializeSharedDependency(bundlePackagesDir, packageName);
    pruneRuntimePackage(join(bundlePackagesDir, packageName));
    const nmDir = join(bundlePackagesDir, packageName, 'node_modules');
    pruneNativePrebuilds(nmDir);
    pruneDateFnsLocales(nmDir);
  }
}

async function stageWorkspacePackages(targetRootDir) {
  stageRuntimePackageTemplate(targetRootDir, 'shared', {
    copyPaths: ['dist'],
    removePaths: ['tsconfig.json'],
  });
  await stageBundledApiRuntime(targetRootDir);
  stageRuntimePackageTemplate(targetRootDir, 'mcp-server', {
    copyPaths: ['dist'],
    removePaths: ['src', 'test', 'tsconfig.json'],
  });
  stageStandaloneWebRuntime(targetRootDir);
}

function stripLeadingDirectory(targetDir, predicate) {
  const matches = [];
  const stack = [targetDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
      if (predicate(fullPath, entry)) {
        matches.push(fullPath);
      }
    }
  }
  if (matches.length === 0) {
    throw new Error(`Could not find expected payload in ${targetDir}`);
  }
  return matches[0];
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'clowder-ai-windows-installer-builder',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      accept: 'application/octet-stream, application/json',
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${url}: ${response.status} ${response.statusText}`);
  }
  ensureDir(dirname(destination));
  await pipeline(response.body, createWriteStream(destination));
}

async function ensureCachedDownload(url, destination) {
  if (existsSync(destination)) {
    return destination;
  }
  await downloadFile(url, destination);
  return destination;
}

function extractZip(archivePath, destination) {
  resetDir(destination);
  const runners = [];
  if (commandExists('unzip')) {
    runners.push(['unzip', ['-q', archivePath, '-d', destination]]);
  }
  const pythonExtractArgs = [
    '-c',
    'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
    archivePath,
    destination,
  ];
  if (commandExists('python3')) {
    runners.push(['python3', pythonExtractArgs]);
  }
  if (commandExists('python')) {
    runners.push(['python', pythonExtractArgs]);
  }
  if (process.platform === 'win32' && commandExists('py')) {
    runners.push(['py', ['-3', ...pythonExtractArgs]]);
  }
  if (commandExists('tar')) {
    runners.push(['tar', ['-xf', archivePath, '-C', destination]]);
  }
  if (process.platform === 'win32' && commandExists('powershell')) {
    runners.push([
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
      ],
    ]);
  }
  let lastError = null;
  for (const [command, args] of runners) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.status === 0) {
      return;
    }
    lastError = new Error(`${command} failed extracting ${archivePath}`);
  }
  throw lastError ?? new Error(`No supported zip extractor found for ${archivePath}`);
}

async function stageWindowsNode(bundleDir, options) {
  const nodeUrl =
    options.nodeZipUrl ?? `https://nodejs.org/dist/${options.nodeVersion}/node-${options.nodeVersion}-win-x64.zip`;
  const archiveName = basename(new URL(nodeUrl).pathname);
  const archivePath = join(options.cacheDir, archiveName);
  await ensureCachedDownload(nodeUrl, archivePath);

  const tempExtract = join(options.cacheDir, 'extract-node');
  extractZip(archivePath, tempExtract);
  const nodeRoot = dirname(
    stripLeadingDirectory(tempExtract, (_fullPath, entry) => entry.isFile() && entry.name.toLowerCase() === 'node.exe'),
  );
  const targetDir = join(bundleDir, 'tools', 'node');
  resetDir(targetDir);
  cpSync(nodeRoot, targetDir, { recursive: true, force: true });
  removePaths(targetDir, ['node_modules', 'corepack', 'include', 'share']);
  walkFiles(targetDir, (fullPath, entry) => {
    if (entry.name.endsWith('.map') || entry.name.endsWith('.md')) {
      rmSync(fullPath, { force: true });
    }
  });
  return { version: options.nodeVersion, url: nodeUrl, archiveName };
}

async function resolveRedisDownload(options) {
  if (options.redisZipUrl) {
    return {
      version: 'manual-override',
      url: options.redisZipUrl,
      archiveName: basename(new URL(options.redisZipUrl).pathname),
      metadataSource: 'manual-override',
    };
  }
  const response = await fetch(options.redisReleaseApi, {
    headers: {
      'user-agent': 'clowder-ai-windows-installer-builder',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`Redis release metadata request failed: ${response.status} ${response.statusText}`);
  }
  const release = await response.json();
  const asset = pickRedisReleaseAsset(release.assets ?? []);
  if (!asset?.browser_download_url) {
    throw new Error(`No Windows Redis zip asset found in ${options.redisReleaseApi}`);
  }
  return {
    version: release.tag_name ?? 'latest',
    url: asset.browser_download_url,
    archiveName: asset.name ?? basename(new URL(asset.browser_download_url).pathname),
    metadataSource: options.redisReleaseApi,
  };
}

async function stageWindowsRedis(bundleDir, options) {
  const download = await resolveRedisDownload(options);
  const archivePath = join(options.cacheDir, download.archiveName);
  await ensureCachedDownload(download.url, archivePath);

  const tempExtract = join(options.cacheDir, 'extract-redis');
  extractZip(archivePath, tempExtract);
  const redisRoot = dirname(
    stripLeadingDirectory(
      tempExtract,
      (_fullPath, entry) => entry.isFile() && entry.name.toLowerCase() === 'redis-server.exe',
    ),
  );

  const redisLayout = join(bundleDir, '.cat-cafe', 'redis', 'windows');
  const currentDir = join(redisLayout, 'current');
  resetDir(currentDir);
  cpSync(redisRoot, currentDir, { recursive: true, force: true });
  ensureDir(join(redisLayout, 'data'));
  ensureDir(join(redisLayout, 'logs'));
  writeFileSync(join(redisLayout, 'current-release.txt'), `${download.version}\n`, 'utf8');
  return download;
}

function writeReleaseMetadata(bundleDir, metadata) {
  const targetPath = join(bundleDir, '.clowder-release.json');
  const tempPath = `${targetPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  rmSync(targetPath, { force: true });
  cpSync(tempPath, targetPath, { force: true });
  rmSync(tempPath, { force: true });
}

function ensureRuntimeSkeleton(bundleDir) {
  ensureDir(join(bundleDir, 'data'));
  ensureDir(join(bundleDir, 'logs'));
  ensureDir(join(bundleDir, '.cat-cafe'));
}

function computeMaxRelativePathLength(bundleDir) {
  let maxLength = 0;
  const stack = [bundleDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const relativePath = relative(bundleDir, fullPath).replaceAll('/', '\\');
      if (relativePath.length > maxLength) {
        maxLength = relativePath.length;
      }
    }
  }
  return maxLength;
}

function ensureBuildArtifacts(options) {
  if (options.skipBuild) {
    return;
  }
  logStep('Building shared, mcp-server, api, and web');
  run('pnpm', ['--filter', '@cat-cafe/shared', 'run', 'build']);
  run('pnpm', ['--filter', '@cat-cafe/mcp-server', 'run', 'build']);
  run('pnpm', ['--filter', '@cat-cafe/api', 'run', 'build']);
  run('pnpm', ['--filter', '@cat-cafe/web', 'run', 'build'], {
    env: { NEXT_TELEMETRY_DISABLED: '1' },
  });
}

function buildWindowsDesktopLauncher(bundleDir, options) {
  const launcherScript = join(repoRoot, 'scripts', 'build-windows-webview2-launcher.ps1');
  const launcherSource = join(repoRoot, 'packaging', 'windows', 'desktop', 'ClowderDesktop.cs');
  const launcherIconPath = join(repoRoot, 'packaging', 'windows', 'assets', 'app.ico');
  if (!existsSync(launcherScript) || !existsSync(launcherSource)) {
    throw new Error('Missing WebView2 launcher build assets');
  }
  if (!commandExists('powershell.exe')) {
    throw new Error('powershell.exe is required to build the Windows WebView2 launcher');
  }

  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    toWindowsPath(launcherScript),
    '-SourceFile',
    toWindowsPath(launcherSource),
    '-OutputDir',
    toWindowsPath(bundleDir),
    '-CacheDir',
    toWindowsPath(options.cacheDir),
    '-WebView2Version',
    options.webview2Version,
    ...(existsSync(launcherIconPath) ? ['-IconFile', toWindowsPath(launcherIconPath)] : []),
  ]);
}

function buildInstallerOutputPath(outputDir, version) {
  return join(outputDir, `OfficeClaw-${version}-windows-x64-setup.exe`);
}

function createPayloadTar(bundleDir, tarPath) {
  rmSync(tarPath, { force: true });
  const tarExe =
    process.platform === 'win32' ? join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  run(tarExe, ['-czf', tarPath, '-C', bundleDir, '.']);
  if (!existsSync(tarPath)) {
    throw new Error(`Failed to create payload archive: ${tarPath}`);
  }
}

function findMakensis() {
  const envPath = process.env.MAKENSIS_PATH;
  if (envPath && commandExists(envPath)) return envPath;
  if (commandExists('makensis')) return 'makensis';
  if (process.platform === 'win32') {
    const candidates = [
      join(process.env.ProgramFiles ?? '', 'NSIS', 'makensis.exe'),
      join(process.env['ProgramFiles(x86)'] ?? '', 'NSIS', 'makensis.exe'),
    ];
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function invokeMakensis(installerScript, outputExe, payloadTar, version) {
  const makensisCommand = findMakensis();
  if (!makensisCommand) {
    throw new Error('makensis not found on PATH or in Program Files. Install NSIS or run with --bundle-only.');
  }
  const definePrefix = process.platform === 'win32' ? '/D' : '-D';
  run(makensisCommand, [
    `${definePrefix}APP_VERSION=${version}`,
    `${definePrefix}PAYLOAD_TAR=${toNsisDirPath(payloadTar)}`,
    `${definePrefix}OUTPUT_EXE=${toNsisFilePath(outputExe)}`,
    toNsisFilePath(installerScript),
  ]);
}

function stageWindowsDesktopAssets(bundleDir) {
  logStep('Staging desktop assets');
  const assetsSource = join(repoRoot, 'packaging', 'windows', 'assets');
  if (existsSync(assetsSource)) {
    cpSync(assetsSource, join(bundleDir, 'assets'), { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundleDir = join(options.outputDir, 'bundle');
  const installerScript = join(repoRoot, 'packaging', 'windows', 'installer.nsi');
  const outputExe = buildInstallerOutputPath(options.outputDir, packageJson.version);

  ensureDir(options.outputDir);
  ensureDir(options.cacheDir);

  // --nsis-only: repackage existing bundle into exe without rebuilding
  if (options.nsisOnly) {
    if (!existsSync(bundleDir)) {
      throw new Error(`Bundle not found at ${bundleDir}. Run without --nsis-only first.`);
    }
    if (!findMakensis()) {
      throw new Error('makensis not found. Install NSIS (https://nsis.sourceforge.io) or set MAKENSIS_PATH.');
    }
    logStep('Creating payload archive');
    const payloadTar = join(options.outputDir, 'payload.tar.gz');
    createPayloadTar(bundleDir, payloadTar);
    logStep('Compiling NSIS installer');
    invokeMakensis(installerScript, outputExe, payloadTar, packageJson.version);
    logStep(`Installer ready at ${outputExe}`);
    return;
  }

  // --launcher-only: rebuild C# launcher into existing bundle
  if (options.launcherOnly) {
    if (!existsSync(bundleDir)) {
      throw new Error(`Bundle not found at ${bundleDir}. Run without --launcher-only first.`);
    }
    logStep('Building WebView2 desktop launcher');
    buildWindowsDesktopLauncher(bundleDir, options);
    stageWindowsDesktopAssets(bundleDir);
    logStep(`Launcher rebuilt in ${bundleDir}`);
    return;
  }

  if (!options.bundleOnly && !findMakensis()) {
    throw new Error(
      'makensis not found. Install NSIS (https://nsis.sourceforge.io) or set MAKENSIS_PATH, or use --bundle-only.',
    );
  }

  // --skip-python: reuse existing tools/python; don't wipe bundle dir
  if (!options.skipPython) {
    logStep('Preparing output directories');
    resetDir(bundleDir);
  } else {
    logStep('Preparing output directories (keeping existing Python)');
    if (!existsSync(bundleDir)) {
      throw new Error(`Bundle not found at ${bundleDir}. Run without --skip-python first to build the full bundle.`);
    }
  }

  ensureBuildArtifacts(options);

  logStep('Copying project sources');
  copyTopLevelProject(bundleDir);
  stageInstallerSeed(bundleDir);

  logStep('Staging vendor Python sources');
  stageVendorPythonSources(bundleDir);

  let pythonEmbed;
  if (!options.skipPython) {
    logStep('Bundling Python embeddable runtime');
    pythonEmbed = await stageWindowsPython(bundleDir, options);

    logStep('Installing shared Python dependencies');
    installSharedPythonDeps(bundleDir);
  } else {
    logStep('Skipping Python embed + pip install (--skip-python)');
    const releaseMetaPath = join(bundleDir, '.clowder-release.json');
    const existingMeta = existsSync(releaseMetaPath) ? JSON.parse(readFileSync(releaseMetaPath, 'utf8')) : {};
    pythonEmbed = existingMeta.pythonEmbed ?? { version: PYTHON_EMBED_VERSION, url: PYTHON_EMBED_URL };
  }

  logStep('Preparing runtime package payload');
  await stageWorkspacePackages(bundleDir);

  logStep('Bundling Windows Node runtime');
  const windowsNode = await stageWindowsNode(bundleDir, options);

  logStep('Bundling portable Redis');
  const redis = await stageWindowsRedis(bundleDir, options);

  logStep('Installing Windows runtime dependencies');
  await installWindowsRuntimeDependencies(bundleDir, options);

  logStep('Building WebView2 desktop launcher');
  buildWindowsDesktopLauncher(bundleDir, options);

  stageWindowsDesktopAssets(bundleDir);

  logStep('Finalizing runtime bundle');
  ensureRuntimeSkeleton(bundleDir);
  writeReleaseMetadata(bundleDir, {
    name: 'Clowder AI',
    version: packageJson.version,
    generatedAt: new Date().toISOString(),
    managedTopLevelPaths: WINDOWS_MANAGED_TOP_LEVEL_PATHS,
    preservedPaths: WINDOWS_PRESERVE_PATHS,
    windowsNode,
    pythonEmbed,
    redis,
    webview2Version: options.webview2Version,
    maxRelativePathLength: computeMaxRelativePathLength(bundleDir),
  });

  if (options.bundleOnly) {
    logStep(`Offline bundle ready at ${bundleDir}`);
    return;
  }

  logStep('Creating payload archive');
  const payloadTar = join(options.outputDir, 'payload.tar.gz');
  createPayloadTar(bundleDir, payloadTar);

  logStep('Compiling NSIS installer');
  invokeMakensis(installerScript, outputExe, payloadTar, packageJson.version);
  logStep(`Installer ready at ${outputExe}`);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(`[windows-installer] ${error.message}`);
    process.exit(1);
  });
}
