import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
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
  write(join(src, 'button/button.js'), "import{helper}from'tslib';import'../common/index.js';\nvoid helper;\n");
  write(join(src, 'button/button.wxml'), '<t-loading />\n');
  write(join(src, 'loading/loading.json'), '{}\n');
  write(join(src, 'loading/loading.js'));
  write(join(src, 'common/index.js'));
  write(join(src, 'miniprogram_npm/tslib/index.js'), 'export const helper = true;\n');
  write(join(src, 'unused/unused.json'), '{}\n');
  write(join(src, 'unused/unused.js'));
  write(join(src, '.wechatide.ib.json'), '{}\n');
  write(join(src, 'button/button.d.ts'), 'export {};\n');
  write(join(src, 'index.d.ts'), 'export {};\n');

  return { root, app, src, out };
}

function createIconFixture() {
  const fixture = createFixture();
  write(
    join(fixture.app, 'app.json'),
    JSON.stringify({
      usingComponents: {
        't-button': 'tdesign-miniprogram/button/button',
        't-icon': 'tdesign-miniprogram/icon/icon',
      },
    }),
  );
  write(join(fixture.app, 'pages/index/index.wxml'), '<t-icon name="close" />\n<t-icon name="{{item.icon}}" />\n');
  write(join(fixture.app, 'pages/index/index.js'), "const icons = { wallet: 'wallet', gift: 'gift' };\nvoid icons;\n");
  write(join(fixture.src, 'icon/icon.json'), '{}\n');
  write(join(fixture.src, 'icon/icon.js'), 'export default {};\n');
  write(join(fixture.src, 'icon/icon.wxml'), '<label class="t-icon-{{name}}"></label>\n');
  write(
    join(fixture.src, 'icon/icon.wxss'),
    [
      "@import '../common/style/index.wxss';",
      "@font-face{font-family:t;src:url(https://example.test/t.woff);}",
      '.t-icon--image{width:100%;}',
      '.t-icon-base{display:block;}',
      '.t-icon{font-family:t!important;}',
      ".t-icon-ability-open:before{content:'\\E001';}",
      ".t-icon-close:before{content:'\\E00D';}",
      ".t-icon-wallet:before{content:'\\E100';}",
      ".t-icon-gift:before{content:'\\E101';}",
      ".t-icon-unused-glyph:before{content:'\\E999';}",
    ].join(''),
  );
  write(join(fixture.src, 'icon/type.d.ts'), 'export {};\n');
  return fixture;
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
    assert.equal(existsSync(join(fixture.out, 'miniprogram_npm/tslib/index.js')), true);
    assert.equal(existsSync(join(fixture.out, 'unused')), false);
    assert.equal(existsSync(join(fixture.out, '.wechatide.ib.json')), false);
    assert.equal(existsSync(join(fixture.out, 'button/button.d.ts')), false);
    assert.equal(existsSync(join(fixture.out, 'index.d.ts')), false);
    assert.equal(existsSync(join(fixture.out, '.tdesign-pruned.json')), true);
    const manifest = JSON.parse(readFileSync(join(fixture.out, '.tdesign-pruned.json'), 'utf8'));
    assert.deepEqual(manifest.deletedComponents, ['unused']);
    assert.deepEqual(manifest.keptEmbed, ['tslib']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('拒绝把输出目录放在源目录内部', () => {
  const fixture = createFixture();
  try {
    const result = run(['--app', fixture.app, '--src', fixture.src, '--out', join(fixture.src, 'pruned')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--out 不能位于 --src 内部/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('按 app 用到的图标名裁剪 icon.wxss，并保留动态绑定文件里的字面量', () => {
  const fixture = createIconFixture();
  try {
    const result = run(['--app', fixture.app, '--src', fixture.src, '--out', fixture.out]);
    assert.equal(result.status, 0, result.stderr);
    const wxss = readFileSync(join(fixture.out, 'icon/icon.wxss'), 'utf8');
    assert.match(wxss, /@font-face/);
    assert.match(wxss, /\.t-icon-close:before/);
    assert.match(wxss, /\.t-icon-wallet:before/);
    assert.match(wxss, /\.t-icon-gift:before/);
    assert.doesNotMatch(wxss, /\.t-icon-ability-open:before/);
    assert.doesNotMatch(wxss, /\.t-icon-unused-glyph:before/);
    const manifest = JSON.parse(readFileSync(join(fixture.out, '.tdesign-pruned.json'), 'utf8'));
    assert.equal(manifest.iconWxssPruned, true);
    assert.ok(manifest.keptIcons.includes('close'));
    assert.ok(manifest.keptIcons.includes('wallet'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('--check 在已裁剪产物上通过，在全量 src 上失败', () => {
  const fixture = createIconFixture();
  try {
    const pruned = run(['--app', fixture.app, '--src', fixture.src, '--out', fixture.out]);
    assert.equal(pruned.status, 0, pruned.stderr);

    const ok = run(['--app', fixture.app, '--src', fixture.src, '--check', fixture.out]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /\[CHECK\] 已有产物与裁剪闭包一致/);

    const bad = run(['--app', fixture.app, '--src', fixture.src, '--check', fixture.src]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /多余组件\/目录/);
    assert.match(bad.stderr, /构建 npm/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('--check 在未裁剪的 icon.wxss 上失败', () => {
  const fixture = createIconFixture();
  try {
    const pruned = run(['--app', fixture.app, '--src', fixture.src, '--out', fixture.out]);
    assert.equal(pruned.status, 0, pruned.stderr);
    write(
      join(fixture.out, 'icon/icon.wxss'),
      readFileSync(join(fixture.src, 'icon/icon.wxss'), 'utf8'),
    );
    const bad = run(['--app', fixture.app, '--src', fixture.src, '--check', fixture.out]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /icon\.wxss 未按需裁剪/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
