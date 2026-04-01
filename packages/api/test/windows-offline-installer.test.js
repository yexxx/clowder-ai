import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeNodeVersion,
  pickRedisReleaseAsset,
  shouldCopyRepoPath,
  shouldUseCommandShell,
  WINDOWS_MANAGED_TOP_LEVEL_PATHS,
  WINDOWS_PRESERVE_PATHS,
} from '../../../scripts/build-windows-installer.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const buildScript = readFileSync(join(repoRoot, 'scripts', 'build-windows-installer.mjs'), 'utf8');
const launcherBuildScript = readFileSync(join(repoRoot, 'scripts', 'build-windows-webview2-launcher.ps1'), 'utf8');
const launcherSource = readFileSync(join(repoRoot, 'packaging', 'windows', 'desktop', 'ClowderDesktop.cs'), 'utf8');
const apiClientSource = readFileSync(join(repoRoot, 'packages', 'web', 'src', 'utils', 'api-client.ts'), 'utf8');
const nsisScript = readFileSync(join(repoRoot, 'packaging', 'windows', 'installer.nsi'), 'utf8');
const windowsInstallHelpersScript = readFileSync(join(repoRoot, 'scripts', 'install-windows-helpers.ps1'), 'utf8');

test('Windows offline installer keeps mutable state outside managed payload cleanup', () => {
  assert.deepEqual(WINDOWS_PRESERVE_PATHS, ['.env', 'cat-config.json', 'data', 'logs', '.cat-cafe']);
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('packages'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('scripts'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('cat-cafe-skills'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('tools'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('installer-seed'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('vendor'));
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('docs'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('README.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('AGENTS.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('CLAUDE.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('GEMINI.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('data'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('.cat-cafe'), false);
});

test('Windows offline installer normalizes bundled Node versions and filters copied repo paths', () => {
  assert.equal(normalizeNodeVersion('22.20.0'), 'v22.20.0');
  assert.equal(normalizeNodeVersion('v20.11.1'), 'v20.11.1');

  assert.equal(shouldCopyRepoPath('packages/api/src/index.ts'), true);
  assert.equal(shouldCopyRepoPath('docs/README.md'), true);
  assert.equal(shouldCopyRepoPath('.env'), false);
  assert.equal(shouldCopyRepoPath('data/evidence.sqlite'), false);
  assert.equal(shouldCopyRepoPath('logs/api.log'), false);
  assert.equal(shouldCopyRepoPath('node_modules/next/package.json'), false);
  assert.equal(shouldCopyRepoPath('packages/api/dist/index.js'), false);
  assert.equal(shouldCopyRepoPath('packages/web/.next/server.js'), false);
  assert.equal(shouldUseCommandShell('pnpm', 'win32'), true);
  assert.equal(shouldUseCommandShell('powershell.exe', 'win32'), true);
  assert.equal(shouldUseCommandShell('C:\\tools\\pnpm.cmd', 'win32'), false);
  assert.equal(shouldUseCommandShell('pnpm', 'linux'), false);
});

test('Windows offline installer prefers plain Redis portable zips before service bundles', () => {
  const asset = pickRedisReleaseAsset([
    { name: 'Redis-8.2.1-Windows-x64-msys2-with-Service.zip', browser_download_url: 'https://example.com/service.zip' },
    { name: 'Redis-8.2.1-Windows-x64-cygwin.zip', browser_download_url: 'https://example.com/cygwin.zip' },
    { name: 'Redis-8.2.1-Windows-x64-msys2.zip', browser_download_url: 'https://example.com/msys2.zip' },
  ]);
  assert.equal(asset?.name, 'Redis-8.2.1-Windows-x64-msys2.zip');
});

test('Windows offline bundle includes restart scripts in the staged runtime payload', () => {
  assert.match(buildScript, /RUNTIME_SCRIPT_FILES = \[/);
  assert.match(buildScript, /'restart-windows\.ps1'/);
  assert.match(buildScript, /'restart\.bat'/);
});

test('Windows offline bundle builder deploys production packages and bundles Windows runtimes', () => {
  assert.match(buildScript, /WINDOWS_RUNTIME_NPM_ARGS = \[\s*'install',\s*'--omit=dev'/);
  assert.match(buildScript, /const entries = \['cat-cafe-skills', 'LICENSE', '\.env\.example', 'cat-template\.json'\]/);
  assert.match(
    buildScript,
    /const DARE_WINDOWS_EXE_SOURCE = join\(repoRoot, 'vendor', 'dare-cli', 'dist', 'dare\.exe'\)/,
  );
  assert.match(
    buildScript,
    /const JIUWENCLAW_WINDOWS_EXE_SOURCE = join\(repoRoot, 'vendor', 'jiuwenclaw', 'dist', 'jiuwenclaw\.exe'\)/,
  );
  assert.match(buildScript, /RUNTIME_SCRIPT_FILES = \[/);
  assert.match(buildScript, /stageRuntimePackageTemplate\(targetRootDir, 'shared'/);
  assert.match(
    buildScript,
    /const API_RUNTIME_EXTERNAL_DEPENDENCIES = \[\s*'better-sqlite3',\s*'node-pty',\s*'pino',\s*'pino-roll',\s*'puppeteer',\s*'sharp',\s*'sqlite-vec',\s*\]/,
  );
  assert.match(buildScript, /await stageBundledApiRuntime\(targetRootDir\)/);
  assert.match(buildScript, /function resolveLocalEsbuildCommand\(\)/);
  assert.match(buildScript, /const esbuildCommand = resolveLocalEsbuildCommand\(\)/);
  assert.match(buildScript, /'--bundle'/);
  assert.match(buildScript, /'--format=esm'/);
  assert.match(
    buildScript,
    /API_RUNTIME_EXTERNAL_DEPENDENCIES\.map\(\(dependency\) => `--external:\$\{dependency\}`\)/,
  );
  assert.match(buildScript, /createRequire as __createRequire/);
  assert.match(buildScript, /fileURLToPath as __fileURLToPath/);
  assert.match(buildScript, /const __dirname = __pathDirname\(__filename\)/);
  assert.match(buildScript, /createBundledApiRuntimePackageJson/);
  assert.match(buildScript, /API bundling unavailable, falling back to staged dist/);
  assert.match(buildScript, /stageRuntimePackageTemplate\(targetRootDir, 'mcp-server'/);
  assert.match(
    buildScript,
    /const WEB_STANDALONE_BUILD_DIR = join\(repoRoot, 'packages', 'web', '\.next', 'standalone'\)/,
  );
  assert.match(buildScript, /const WEB_RUNTIME_DEPENDENCIES = \['next', 'react', 'react-dom', 'sharp'\]/);
  assert.match(buildScript, /stageStandaloneWebRuntime\(targetRootDir\)/);
  assert.match(buildScript, /dependencies\['@cat-cafe\/shared'\] = 'file:\.\.\/shared'/);
  assert.match(buildScript, /const RUNTIME_WEB_STANDALONE_SERVER = `const fs = require\('node:fs'\);/);
  assert.match(buildScript, /const requiredServerFiles = JSON\.parse\(/);
  assert.match(buildScript, /function createStandaloneWebRuntimePackageJson\(sourcePath\)/);
  assert.match(buildScript, /resolveInstalledPackageVersion\(WEB_STANDALONE_NODE_MODULES_DIR, dependency\)/);
  assert.match(buildScript, /cpSync\(WEB_STANDALONE_APP_DIR, targetDir, \{ recursive: true, force: true \}\)/);
  assert.match(buildScript, /rmSync\(join\(targetDir, 'node_modules'\), \{ recursive: true, force: true \}\)/);
  assert.match(buildScript, /copyIfPresent\(WEB_BUILD_STATIC_DIR, join\(targetDir, '\.next', 'static'\)\)/);
  assert.match(buildScript, /copyIfPresent\(join\(sourceDir, '\.next'\), join\(targetDir, '\.next'\)\)/);
  assert.match(
    buildScript,
    /copyIfPresent\(join\(sourceDir, 'next\.config\.js'\), join\(targetDir, 'next\.config\.js'\)\)/,
  );
  assert.match(
    buildScript,
    /writeJson\(join\(targetDir, 'package\.json'\), createStandaloneWebRuntimePackageJson\(join\(repoRoot, 'packages', 'web', 'package\.json'\)\)\)/,
  );
  assert.match(buildScript, /writeFileSync\(join\(targetDir, 'server\.js'\), RUNTIME_WEB_STANDALONE_SERVER, 'utf8'\)/);
  assert.match(buildScript, /runWindowsNpmInstall\(windowsNode\.npmCmdPath/);
  assert.match(buildScript, /for \(const packageName of \['api', 'mcp-server', 'web'\]\)/);
  assert.match(buildScript, /buildVendoredDareExecutable\(options\)/);
  assert.match(buildScript, /stageVendoredDareExecutable\(bundleDir, dareExecutable\)/);
  assert.match(buildScript, /cpSync\(executablePath, join\(vendorDir, 'dare\.exe'\), \{ force: true \}\)/);
  assert.match(buildScript, /buildVendoredJiuwenClawExecutable\(options\)/);
  assert.match(buildScript, /stageVendoredJiuwenClawExecutable\(bundleDir, jiuwenClawExecutable\)/);
  assert.match(buildScript, /cpSync\(executablePath, join\(vendorDir, 'jiuwenclaw\.exe'\), \{ force: true \}\)/);
  assert.match(buildScript, /'install-python-wheelhouse\.ps1'/);
  assert.match(buildScript, /'manual-install-windows-runtime-wheelhouse\.ps1'/);
  assert.match(buildScript, /const DEFAULT_WHEELHOUSE_DIR = join\(repoRoot, 'dist', 'windows-python-wheelhouse'\)/);
  assert.match(
    buildScript,
    /const PYTHON_WHEELHOUSE_CONFIG = join\(repoRoot, 'packaging', 'windows', 'python-runtime-wheelhouse\.json'\)/,
  );
  assert.match(buildScript, /function writePythonRuntimePth\(targetDir, options = \{\}\)/);
  assert.match(buildScript, /writePythonRuntimePth\(targetDir, \{ includeVendorPaths: false \}\)/);
  assert.match(buildScript, /function resolveStagedWindowsPythonWheelhouse\(\)/);
  assert.match(buildScript, /function stageWindowsPythonWheelhouse\(\)/);
  assert.match(buildScript, /logStep\('Preparing Python wheelhouse'\)/);
  assert.match(buildScript, /pythonWheelhouse = stageWindowsPythonWheelhouse\(\)/);
  assert.match(buildScript, /pythonWheelhouse = resolveStagedWindowsPythonWheelhouse\(\)/);
  assert.match(buildScript, /stageInstallerSeed\(bundleDir, pythonWheelhouse\)/);
  assert.match(
    buildScript,
    /cpSync\(wheelhouse\.manifestPath, join\(seedDir, 'python-wheelhouse-manifest\.json'\), \{ force: true \}\)/,
  );
  assert.match(
    buildScript,
    /cpSync\(wheelhouseSource, join\(seedDir, 'wheelhouse'\), \{ recursive: true, force: true \}\)/,
  );
  assert.match(
    buildScript,
    /if \(entry\.name\.endsWith\('\\.egg-info'\) \|\| entry\.name\.endsWith\('\\.dist-info'\)\) continue;/,
  );
  assert.doesNotMatch(buildScript, /__pycache__/);
  assert.doesNotMatch(buildScript, /entry\.name\.endsWith\('\\.pyc'\)/);
  assert.match(buildScript, /run\('pnpm', \['--filter', '@cat-cafe\/shared', 'run', 'build'\]\)/);
  assert.match(buildScript, /shell: options\.shell \?\? shouldUseCommandShell\(command\)/);
  assert.match(buildScript, /materializeSharedDependency\(bundlePackagesDir, packageName\)/);
  assert.match(buildScript, /lstatSync\(sharedLinkPath\)\.isSymbolicLink\(\)/);
  assert.match(buildScript, /powershell\.exe/);
  assert.match(buildScript, /--package-lock=false/);
  assert.match(buildScript, /--loglevel=error/);
  assert.match(buildScript, /'next-env\.d\.ts'/);
  assert.match(buildScript, /'postcss\.config\.js'/);
  assert.match(buildScript, /'tailwind\.config\.js'/);
  assert.match(buildScript, /'vitest\.config\.ts'/);
  assert.match(buildScript, /'\.next\/types'/);
  assert.match(buildScript, /removeNamedDirectoriesRecursive\(targetDir, \['test', 'tests', '__tests__'\]\)/);
  assert.match(buildScript, /fileName === 'package-lock\.json' \|\| fileName === '\.package-lock\.json'/);
  assert.match(buildScript, /removePaths\(targetDir, \['node_modules', 'corepack', 'include', 'share'\]\)/);
  assert.match(buildScript, /computeMaxRelativePathLength\(bundleDir\)/);
  assert.match(buildScript, /MAX_REL_PATH_LEN=/);
  assert.match(buildScript, /MAX_INSTALL_ROOT_LEN=/);
  assert.match(buildScript, /node-\$\{options\.nodeVersion\}-win-x64\.zip/);
  assert.match(buildScript, /redis-windows\/redis-windows\/releases\/latest/);
  assert.match(buildScript, /build-windows-webview2-launcher\.ps1/);
  assert.match(buildScript, /createIcoFromPng\(launcherIconSource, launcherIconPath\)/);
  assert.match(buildScript, /wslpath is required to build the Windows WebView2 launcher from Linux/);
  assert.match(buildScript, /Building WebView2 desktop launcher/);
  assert.match(buildScript, /Finalizing runtime bundle/);
  assert.match(buildScript, /writeReleaseMetadata\(bundleDir, \{/);
});

test('JiuwenClaw build spec targets a self-contained Windows executable and exposes a sidecar app flag', () => {
  const jiuwenSpec = readFileSync(join(repoRoot, 'vendor', 'jiuwenclaw', 'scripts', 'jiuwenclaw.spec'), 'utf8');
  const jiuwenBuildScript = readFileSync(join(repoRoot, 'vendor', 'jiuwenclaw', 'scripts', 'build-exe.ps1'), 'utf8');
  const jiuwenEntry = readFileSync(
    join(repoRoot, 'vendor', 'jiuwenclaw', 'scripts', 'jiuwenclaw_exe_entry.py'),
    'utf8',
  );

  assert.match(jiuwenSpec, /if sys\.platform == "win32":/);
  assert.match(jiuwenSpec, /a\.binaries/);
  assert.match(jiuwenSpec, /a\.zipfiles/);
  assert.match(jiuwenSpec, /a\.datas/);
  assert.doesNotMatch(
    jiuwenSpec,
    /COLLECT\(\s*exe,\s*a\.binaries,\s*a\.zipfiles,\s*a\.datas,\s*strip=False,\s*upx=True,\s*upx_exclude=\[\],\s*name="jiuwenclaw"\s*\)\s*$/m,
  );
  assert.match(jiuwenBuildScript, /Resolve-UvCommand/);
  assert.match(jiuwenBuildScript, /\.build-venv/);
  assert.match(jiuwenBuildScript, /pip install -e "\.\[dev\]"/);
  assert.match(jiuwenEntry, /--desktop-run-app/);
});

test('DARE build spec exposes a standalone CLI executable with mirrored packaging scripts', () => {
  const dareSpec = readFileSync(join(repoRoot, 'vendor', 'dare-cli', 'scripts', 'dare.spec'), 'utf8');
  const dareBuildScript = readFileSync(join(repoRoot, 'vendor', 'dare-cli', 'scripts', 'build-exe.ps1'), 'utf8');
  const dareEntry = readFileSync(join(repoRoot, 'vendor', 'dare-cli', 'scripts', 'dare_exe_entry.py'), 'utf8');
  const dareReadme = readFileSync(join(repoRoot, 'vendor', 'dare-cli', 'scripts', 'README-pyinstaller.md'), 'utf8');

  assert.match(dareSpec, /collect_submodules\("client"\)/);
  assert.match(dareSpec, /collect_submodules\("dare_framework"\)/);
  assert.match(dareSpec, /client\/examples\/basic\.script\.txt/);
  assert.match(dareSpec, /copy_metadata\("langchain-openai", recursive=True\)/);
  assert.match(dareSpec, /name="dare"/);
  assert.match(dareBuildScript, /Resolve-UvCommand/);
  assert.match(dareBuildScript, /\.build-venv/);
  assert.match(dareBuildScript, /requirements\.txt/);
  assert.match(dareBuildScript, /PyInstaller/);
  assert.match(dareEntry, /multiprocessing\.freeze_support/);
  assert.match(dareEntry, /sync_main/);
  assert.match(dareReadme, /dist\/dare\.exe/);
});

test('Windows WebView2 launcher build bundles the required SDK files and desktop host logic', () => {
  assert.match(launcherBuildScript, /microsoft\.web\.webview2\.\$WebView2Version\.nupkg/);
  assert.match(launcherBuildScript, /Microsoft\.Web\.WebView2\.Core\.dll/);
  assert.match(launcherBuildScript, /Microsoft\.Web\.WebView2\.WinForms\.dll/);
  assert.match(launcherBuildScript, /WebView2Loader\.dll/);
  assert.match(launcherBuildScript, /ClowderAI\.Desktop\.exe/);
  assert.match(launcherBuildScript, /csc\.exe/);
  assert.match(launcherBuildScript, /\/win32icon:\$IconFile/);

  assert.match(launcherSource, /new WebView2/);
  assert.match(launcherSource, /EnsureCoreWebView2Async/);
  assert.match(launcherSource, /start-windows\.ps1/);
  assert.match(launcherSource, /stop-windows\.ps1/);
  assert.match(launcherSource, /Local\\ClowderAI\.WebView2Desktop/);
  assert.match(launcherSource, /http:\/\/127\.0\.0\.1:/);
});

test('Windows desktop launcher reads runtime state, minimizes to tray, and exits through the tray menu', () => {
  assert.match(launcherSource, /runtime-state\.json/);
  assert.match(launcherSource, /NotifyIcon/);
  assert.match(launcherSource, /ContextMenuStrip/);
  assert.match(launcherSource, /Open Clowder AI/);
  assert.match(launcherSource, /HideToTray/);
  assert.match(launcherSource, /RequestExit/);
  assert.match(launcherSource, /TryReadRuntimeStateValue/);
  assert.match(launcherSource, /ShowBalloonTip/);
});

test('Windows startup script pins bundled config roots for packaged releases', () => {
  assert.match(buildScript, /'cat-template\.json'/);
  assert.match(buildScript, /'\.clowder-release\.json'/);
  assert.match(launcherSource, /AppDomain\.CurrentDomain\.BaseDirectory/);
  const startWindowsScript = readFileSync(join(repoRoot, 'scripts', 'start-windows.ps1'), 'utf8');
  assert.match(startWindowsScript, /Mount-InstallerSkills -ProjectRoot \$ProjectRoot/);
  assert.match(startWindowsScript, /if \(\$bundledRelease\) \{/);
  assert.match(startWindowsScript, /\$runtimeEnvOverrides\.CAT_CAFE_CONFIG_ROOT = \$ProjectRoot/);
  assert.match(startWindowsScript, /\$runtimeEnvOverrides\.CAT_TEMPLATE_PATH = \$bundledTemplatePath/);
  assert.match(startWindowsScript, /\$webStandaloneServer = Join-Path \$ProjectRoot "packages\/web\/server\.js"/);
  assert.match(
    startWindowsScript,
    /\$usingStandaloneWebRuntime = \(-not \$Dev\) -and \(Test-Path \$webStandaloneServer\)/,
  );
  assert.match(startWindowsScript, /Starting Frontend \(port \$WebPort, standalone\)/);
  assert.match(startWindowsScript, /\$env:HOSTNAME = "0\.0\.0\.0"/);
});

test('Windows skill mount keeps refs and top-level skill metadata files', () => {
  assert.doesNotMatch(windowsInstallHelpersScript, /Where-Object \{ \$_.Name -ne "refs" \}/);
  assert.match(windowsInstallHelpersScript, /\$skillItems = Get-ChildItem \$skillsSource -Force/);
  assert.match(windowsInstallHelpersScript, /if \(\$skill\.PSIsContainer\) \{/);
  assert.match(windowsInstallHelpersScript, /Mount-InstallerSkillDirectory/);
  assert.match(windowsInstallHelpersScript, /Sync-InstallerSkillFile/);
  assert.match(windowsInstallHelpersScript, /Copy-Item -Path \$SourcePath -Destination \$TargetPath -Force/);
});

test('Local desktop web client derives API URL from the loopback frontend port instead of a baked localhost:3004 value', () => {
  assert.match(apiClientSource, /function isLoopbackHost/);
  assert.match(apiClientSource, /if \(isLoopbackHost\(location\?\.hostname\)\)/);
  assert.match(apiClientSource, /const frontendPort = Number\(location\?\.port \?\? ''\) \|\| 3003/);
  assert.match(apiClientSource, /const apiPort = frontendPort \+ 1/);
});

test('NSIS installer is per-user, supports upgrade cleanup, and preserves runtime data on uninstall', () => {
  assert.match(nsisScript, /!define DEFAULT_INSTALL_DIR "C:\\CAI"/);
  assert.match(nsisScript, /InstallDir "\$\{DEFAULT_INSTALL_DIR\}"/);
  assert.match(nsisScript, /!define MUI_PAGE_CUSTOMFUNCTION_LEAVE VerifyInstallDirLeave/);
  assert.match(nsisScript, /Function \.onVerifyInstDir/);
  assert.match(nsisScript, /Function VerifyInstallDirLeave/);
  assert.match(nsisScript, /Choose a path with at most \$\{MAX_INSTALL_ROOT_LEN\} characters/);
  assert.match(nsisScript, /RequestExecutionLevel user/);
  assert.match(nsisScript, /Function CloseRunningServices/);
  assert.match(
    nsisScript,
    /ExecWait '"\$WINDIR\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile -ExecutionPolicy Bypass -File "\$INSTDIR\\scripts\\stop-windows\.ps1"'/,
  );
  assert.match(nsisScript, /RMDir \/r "\$INSTDIR\\packages"/);
  assert.match(nsisScript, /RMDir \/r "\$INSTDIR\\tools"/);
  assert.match(nsisScript, /IfFileExists "\$INSTDIR\\\.env" \+2 0/);
  assert.match(nsisScript, /CopyFiles \/SILENT "\$INSTDIR\\\.env\.example" "\$INSTDIR\\\.env"/);
  assert.match(
    nsisScript,
    /CopyFiles \/SILENT "\$INSTDIR\\installer-seed\\cat-config\.json" "\$INSTDIR\\cat-config\.json"/,
  );
  assert.match(nsisScript, /WriteRegStr HKCU "\$\{UNINSTALL_KEY\}" "DisplayVersion" "\$\{APP_VERSION\}"/);
  assert.match(
    nsisScript,
    /CreateShortCut "\$\{STARTMENU_DIR\}\\Start \$\{APP_NAME\}\.lnk" "\$INSTDIR\\ClowderAI\.Desktop\.exe" "" "\$INSTDIR\\ClowderAI\.Desktop\.exe"/,
  );
  assert.match(
    nsisScript,
    /CreateShortCut "\$DESKTOP\\\$\{APP_NAME\}\.lnk" "\$INSTDIR\\ClowderAI\.Desktop\.exe" "" "\$INSTDIR\\ClowderAI\.Desktop\.exe"/,
  );
  assert.match(nsisScript, /Delete "\$DESKTOP\\\$\{APP_NAME\}\.lnk"/);
  assert.match(nsisScript, /User data in data, logs, \.cat-cafe, \.env, and cat-config\.json was preserved/);
});
