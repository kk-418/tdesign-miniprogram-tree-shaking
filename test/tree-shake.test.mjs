import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'tree-shake.mjs');

function write(file, content = '') {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tdesign-prune-'));
  const app = join(root, 'app');
  const src = join(root, 'src');
  const out = join(root, 'out');

  write(
    join(app, 'app.json'),
    JSON.stringify({ usingComponents: { 't-button': 'tdesign-miniprogram/button/button' } }),
  );
  write(
    join(src, 'button/button.json'),
    JSON.stringify({ usingComponents: { 't-loading': '../loading/loading' } }),
  );
  write(join(src, 'button/button.js'), "import '../common/index.js';\n");
  write(join(src, 'button/button.wxml'), '<t-loading />\n');
  write(join(src, 'loading/loading.json'), '{}\n');
  write(join(src, 'loading/loading.js'));
  write(join(src, 'common/index.js'));
  write(join(src, 'unused/unused.json'), '{}\n');
  write(join(src, 'unused/unused.js'));
  write(join(src, '.wechatide.ib.json'), '{}\n');

  return { root, app, src, out };
}

test('生成独立裁剪产物并保留组件依赖闭包', () => {
  const fixture = createFixture();
  try {
    execFileSync(process.execPath, [cli, '--app', fixture.app, '--src', fixture.src, '--out', fixture.out], {
      stdio: 'pipe',
    });

    assert.equal(existsSync(join(fixture.src, 'unused/unused.js')), true, '源目录必须保持不变');
    assert.equal(existsSync(join(fixture.out, 'button/button.js')), true);
    assert.equal(existsSync(join(fixture.out, 'loading/loading.js')), true);
    assert.equal(existsSync(join(fixture.out, 'common/index.js')), true);
    assert.equal(existsSync(join(fixture.out, 'unused')), false);
    assert.equal(existsSync(join(fixture.out, '.wechatide.ib.json')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('拒绝把输出目录放在源目录内部', () => {
  const fixture = createFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [cli, '--app', fixture.app, '--src', fixture.src, '--out', join(fixture.src, 'pruned')],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--out 不能位于 --src 内部/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
