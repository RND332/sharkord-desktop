const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { build } = require('esbuild');
const asar = require('@electron/asar');
if (process.platform !== 'win32') throw new Error('Run the native shortcut test on Windows');
const repo = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sharkord-windows-shortcuts-'));
const resultDir = path.join(repo, 'test-results');
fs.mkdirSync(resultDir, { recursive: true });
const packages = fs.readdirSync(path.join(repo, 'release')).map(name => path.join(repo, 'release', name))
  .filter(dir => fs.existsSync(path.join(dir, 'resources', 'app.asar')));
assert.equal(packages.length, 1, 'expected one unpacked Windows app');
const resources = path.join(packages[0], 'resources');
const appArchive = path.join(resources, 'app.asar');
const helper = path.join(resources, 'native', 'win-voice-shortcuts.exe');
assert.deepEqual(fs.readFileSync(helper), fs.readFileSync(path.join(repo, 'native', 'out', 'win-voice-shortcuts.exe')));
const packagedVersion = JSON.parse(asar.extractFile(appArchive, 'package.json').toString()).version;
assert.equal(packagedVersion, require('../package.json').version);
for (const file of ['main.js', 'preload.js']) {
  assert.deepEqual(asar.extractFile(appArchive, 'dist/' + file), fs.readFileSync(path.join(repo, 'dist', file)), 'packaged bundle differs: ' + file);
}
const electron = require('electron');
const fixtureMain = path.join(__dirname, 'windows-voice-shortcuts-native.cjs');
const run = (baseline, main) => {
  const folder = path.join(scratch, baseline ? 'baseline-app' : 'candidate-app');
  fs.mkdirSync(path.join(folder, 'native', 'out'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'app-data'), { recursive: true });
  fs.copyFileSync(helper, path.join(folder, 'native', 'out', 'win-voice-shortcuts.exe'));
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'sharkord-shortcuts-fixture', version: packagedVersion, main: 'main.cjs' }));
  fs.writeFileSync(path.join(folder, 'main.cjs'), 'require(' + JSON.stringify(fixtureMain) + ');\n');
  const output = path.join(folder, 'result.json');
  const child = spawnSync(electron, [folder], {
    cwd: repo,
    env: { ...process.env, SHARKORD_SHORTCUT_MAIN: main, SHARKORD_SHORTCUT_RESULT: output, SHARKORD_SHORTCUT_BASELINE: baseline ? '1' : '0' },
    encoding: 'utf8', timeout: 75000, windowsHide: true
  });
  if (child.error) throw child.error;
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  if (child.status !== (baseline ? 42 : 0)) {
    throw new Error(JSON.stringify({ baseline, status: child.status, result, stdout: child.stdout, stderr: child.stderr }));
  }
  assert.ok(result);
  if (baseline) assert.equal(result.expectedMissingGlobalBindings, true);
  else assert.equal(result.verified, true);
  return result;
};
const verifyReleasedBindings = () => new Promise((resolve, reject) => {
  const child = spawn(helper, [], { stdio: 'pipe', windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const seen = [];
  let diagnostics = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('helper cleanup probe timed out')); }, 5000);
  child.stderr.on('data', data => { diagnostics += data; });
  lines.on('line', line => {
    seen.push(line);
    if (line === 'READY') child.stdin.end();
  });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => {
    clearTimeout(timer);
    lines.close();
    try {
      assert.equal(code, 0, diagnostics);
      assert.ok(seen.includes('REGISTERED Ctrl+Shift+M'), diagnostics);
      assert.ok(seen.includes('REGISTERED Ctrl+Shift+D'), diagnostics);
      resolve();
    } catch (error) { reject(error); }
  });
});
(async () => {
  const baselineDir = path.join(scratch, 'baseline-source');
  let worktree = false;
  try {
    execFileSync('git', ['fetch', 'origin', 'tag', 'v0.6.17'], { cwd: repo, stdio: 'inherit' });
    assert.equal(execFileSync('git', ['rev-parse', 'v0.6.17^{commit}'], { cwd: repo, encoding: 'utf8' }).trim(), 'b740f0a985ede57a856ea6252fd3883f4fc6df9b');
    execFileSync('git', ['worktree', 'add', '--detach', baselineDir, 'v0.6.17'], { cwd: repo, stdio: 'inherit' });
    worktree = true;
    const dist = path.join(baselineDir, 'dist');
    fs.mkdirSync(dist);
    const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], nodePaths: [path.join(repo, 'node_modules')] };
    await build({ ...common, entryPoints: [path.join(baselineDir, 'src/main/index.ts')], outfile: path.join(dist, 'main.js') });
    await build({ ...common, entryPoints: [path.join(baselineDir, 'src/preload/index.ts')], outfile: path.join(dist, 'preload.js') });
    await build({ bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', nodePaths: [path.join(repo, 'node_modules')], entryPoints: [path.join(baselineDir, 'src/patch/entry.ts')], outfile: path.join(dist, 'patch.js') });
    fs.copyFileSync(path.join(baselineDir, 'build/icon.png'), path.join(dist, 'icon.png'));
    fs.copyFileSync(path.join(baselineDir, 'src/connect/connect.html'), path.join(dist, 'connect.html'));
    fs.copyFileSync(path.join(baselineDir, 'src/picker/picker.html'), path.join(dist, 'picker.html'));
    const baseline = run(true, path.join(dist, 'main.js'));
    await verifyReleasedBindings();
    const candidate = run(false, path.join(appArchive, 'dist', 'main.js'));
    await verifyReleasedBindings();
    const result = { verified: true, platform: process.platform, version: packagedVersion, baseline, candidate, nativeBindingsReleased: true, helperSha256: crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex') };
    fs.writeFileSync(path.join(resultDir, 'windows-shortcuts.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (worktree) execFileSync('git', ['worktree', 'remove', '--force', baselineDir], { cwd: repo, stdio: 'inherit' });
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
