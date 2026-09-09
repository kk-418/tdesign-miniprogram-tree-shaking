#!/usr/bin/env node
/**
 * tree-shake.mjs — 组件依赖闭包裁剪（物理 tree-shaking）
 *
 * 把全量 tdesign-miniprogram dist 按某个下游小程序 app 实际用到的组件做物理裁剪，
 * 删掉未被引用的组件目录与开发期冗余文件，减小 miniprogram_npm 包体积。
 *
 * 背景：app.json 即使开启 lazyCodeLoading:"requiredComponents" 也只优化启动注入、不减包体积，
 * 所以必须物理删文件。
 *
 * 用法：
 *   node tree-shake.mjs --app <appMiniprogramDir> --src <fullDistDir> --out <prunedDistDir> [--lib <pkgName>] [--dry-run] [--force]
 *   node tree-shake.mjs --app <app> --src <fullDistDir> --check <existingPrunedDir>
 *
 *   --app      下游小程序源码根目录（含 app.json / pages / components 的 .json）
 *   --src      全量 tdesign dist 目录（只读）
 *   --out      输出裁剪后的 tdesign dist 目录（会先清空再写入；与 --check 互斥时可省略）
 *   --lib      组件库 npm 包名（默认 tdesign-miniprogram，用于识别带库名前缀的引用）
 *   --dry-run  只打印将删除/保留清单，不写 out，不真正删
 *   --force    跳过"根集为空"安全护栏（谨慎使用，可能删光整个 dist）
 *   --check    断言已有产物目录已按当前 app 裁剪（不写文件）。多余组件目录 / 未裁 icon.wxss 则失败。
 *   --no-prune-icons  保留完整 icon.wxss（默认会按 app + 保留组件用到的图标名做子集）
 *
 * 算法：
 *   1. 求根集：扫描 app 下所有 .json（排除其 miniprogram_npm/）的 usingComponents /
 *      componentGenerics，凡 value 解析后落在 dist 内的，取其顶层组件目录名为根。
 *      根集为空时默认中止（防止误删整个库），可用 --force 强制执行。
 *   2. BFS 求传递闭包：读 dist 内组件 json 的 usingComponents/componentGenerics，
 *      把指向其它 tdesign 组件的相对路径解析进集合，迭代到不动点。
 *   3. 始终保留共享目录：common / mixins / locale / config-provider。
 *   4. 内嵌依赖：扫描"保留组件目录 + 共享目录"内的 @import(wxss) / <wxs src>(wxml) /
 *      require|import|动态 import(js) 对 dist 根下其它顶层目录/文件（含 miniprogram_npm/<lib>）的引用，
 *      被引用项加入保留集，迭代到不动点（保守：宁可多留不可错删）。
 *      common/shared/<name> 子目录的保留按"与保留组件同名 ∪ 被保留文件真实引用"判定。
 *   5. 删除 dist 顶层中不在保留集的目录；保留 dist 根下的 .json/注册清单等工具文件。
 *   6. 删除 .wechatide.ib.json（微信 IDE 组件库 IB 索引，见 REDUNDANT_FILE_NAMES）：
 *      工具现场扫描 miniprogram_npm 识别组件库，产物无此文件则不登记、不读，避免 upload ENOENT。
 *   7. 删除保留目录内的 *.d.ts / *.d.ts.map（运行时不需要）。
 *   8. 若保留了 icon 组件：按 app + 保留组件源码中的图标名字面量，裁剪 icon.wxss 的 :before 规则。
 *   9. 写入 .tdesign-pruned.json 裁剪清单，供 --check 与人工排查。
 *
 * 仅用 Node 内置模块，node 直接可跑。
 *
 * 消费端注意：不要用微信开发者工具「构建 npm」覆盖裁剪产物（会还原全量 dist）。
 * 用 --check 守门。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI 解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    app: '',
    src: '',
    out: '',
    dryRun: false,
    force: false,
    lib: 'tdesign-miniprogram',
    check: '',
    pruneIcons: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--app') args.app = argv[++i];
    else if (a === '--src') args.src = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--lib') args.lib = argv[++i];
    else if (a === '--check') args.check = argv[++i];
    else if (a === '--dry-run' || a === '--dryRun') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--no-prune-icons') args.pruneIcons = false;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node tree-shake.mjs --app <appMiniprogramDir> --src <fullDistDir> --out <prunedDistDir> [--lib <pkgName>] [--dry-run] [--force] [--no-prune-icons]',
      '  node tree-shake.mjs --app <appMiniprogramDir> --src <fullDistDir> --check <existingPrunedDir> [--lib <pkgName>] [--no-prune-icons]',
    ].join('\n'),
  );
}

// 始终保留的共享目录（顶层目录名）
const ALWAYS_KEEP = new Set(['common', 'mixins', 'locale', 'config-provider']);

// 开发期冗余文件名（位于任意层级，删除）。
// .wechatide.ib.json（微信 IDE 组件库 IB 索引）在此删除：经实验确证，微信开发者工具
// 是「现场扫描 miniprogram_npm」识别组件库——产物不含该文件时工具初次扫描即不登记、不读它，
// 故删除可彻底避免 upload 期 `ENOENT .wechatide.ib.json`。代价是失去该库在 IDE 的组件提示。
// （勿改回「重写保留」：保留会让工具登记该组件库并在 build/upload 主动 open 它，一旦同步出现
//   「删了还没写回」的中间态即 ENOENT。删除从源头消除这个面。）
const REDUNDANT_FILE_NAMES = new Set(['.wechatide.ib.json']);
const REDUNDANT_SUFFIXES = ['.d.ts.map', '.d.ts'];
const MANIFEST_NAME = '.tdesign-pruned.json';
const ICON_WXSS_REL = path.join('icon', 'icon.wxss');
const ICON_EXTRA_FAIL_THRESHOLD = 100;

// 内嵌 npm 容器目录名
const EMBED_NPM_DIR = 'miniprogram_npm';

// 显式带库名前缀的引用 marker（运行时由 --lib 填充，main() 中设置）。
let LIB_MARKERS = ['tdesign-miniprogram/'];

const log = (...m) => console.log(...m);
const warn = (...m) => console.warn('[warn]', ...m);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function prepareOutputDir(srcRoot, outRoot) {
  const normSrc = path.resolve(srcRoot);
  const normOut = path.resolve(outRoot);
  if (normOut === normSrc) {
    console.error('[error] --out 不能等于 --src；请输出到独立目录');
    process.exit(1);
  }
  if (normOut.startsWith(normSrc + path.sep)) {
    console.error('[error] --out 不能位于 --src 内部；请输出到独立目录');
    process.exit(1);
  }

  fs.rmSync(normOut, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(normOut), { recursive: true });
  fs.cpSync(normSrc, normOut, { recursive: true, force: true });
  return normOut;
}

/** 递归列出目录下所有文件（绝对路径），可传入需跳过的绝对目录集合 */
function walkFiles(root, skipDirs = new Set()) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(full)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    warn(`解析 JSON 失败，跳过：${file} (${err.message})`);
    return null;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const kb = (bytes) => (bytes / 1024).toFixed(1);

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function hasRedundantSuffix(name) {
  return REDUNDANT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * 给定 dist 内某个引用路径（usingComponents/generics 的 value、或源码内 import 的相对路径），
 * 返回它落在 dist 内的"顶层条目名"（顶层目录或顶层文件，去掉后续路径）。
 * fromFile：发起引用的文件绝对路径（用于解析相对路径）。
 * 返回 null 表示该引用不落在 dist 内（外部包、网络组件等）。
 */
function resolveTopLevelEntry(distRoot, fromFile, ref) {
  if (!ref || typeof ref !== 'string') return null;
  // 去掉协议/网络组件占位
  if (ref.startsWith('plugin://') || ref.startsWith('plugin-private://')) return null;

  // 显式带库名前缀：.../<lib>/<comp>/...（兼容 plus / 非 plus）
  for (const marker of LIB_MARKERS) {
    const mi = ref.indexOf(marker);
    if (mi !== -1) {
      const rest = ref.slice(mi + marker.length);
      return firstSegment(rest);
    }
  }

  let abs;
  if (ref.startsWith('/')) {
    // 小程序绝对路径（相对 app 根）——通常不指向 dist，但若文本恰好是 dist 内绝对路径也兼容
    if (ref.startsWith(distRoot + path.sep) || ref === distRoot) {
      abs = ref;
    } else {
      return null;
    }
  } else if (ref.startsWith('.')) {
    abs = path.resolve(path.dirname(fromFile), ref);
  } else {
    // 裸标识符：可能是内嵌 npm 包（dayjs / tslib / marked ...）
    const bareTop = firstSegment(ref);
    const embedded = path.join(distRoot, EMBED_NPM_DIR, bareTop);
    if (exists(embedded) || exists(embedded + '.js')) {
      return `${EMBED_NPM_DIR}/${bareTop}`;
    }
    return null;
  }

  const normDist = path.resolve(distRoot);
  const normAbs = path.resolve(abs);
  if (normAbs !== normDist && !normAbs.startsWith(normDist + path.sep)) return null;

  const rel = path.relative(normDist, normAbs);
  if (!rel || rel.startsWith('..')) return null;
  // 内嵌 npm：保留到二级（miniprogram_npm/<lib>）
  const segs = rel.split(path.sep);
  if (segs[0] === EMBED_NPM_DIR && segs.length >= 2) {
    return `${EMBED_NPM_DIR}/${segs[1]}`;
  }
  return segs[0];
}

function firstSegment(p) {
  const clean = p.replace(/^[./]+/, '');
  const seg = clean.split('/')[0];
  return seg || null;
}

/**
 * 若引用解析后落在 dist/common/shared/<name> 内，返回 <name>，否则 null。
 * 用于让 shared 子目录的保留按"真实被引用"判定，而非纯组件同名匹配。
 */
function resolveSharedSubdir(distRoot, fromFile, ref) {
  if (!ref || typeof ref !== 'string') return null;
  let abs;
  if (ref.startsWith('.')) {
    abs = path.resolve(path.dirname(fromFile), ref);
  } else if (ref.startsWith('/')) {
    if (ref.startsWith(distRoot + path.sep)) abs = ref;
    else return null;
  } else {
    return null;
  }
  const sharedRoot = path.join(path.resolve(distRoot), 'common', 'shared');
  const norm = path.resolve(abs);
  if (norm !== sharedRoot && !norm.startsWith(sharedRoot + path.sep)) return null;
  const rel = path.relative(sharedRoot, norm);
  if (!rel || rel.startsWith('..')) return null;
  return rel.split(path.sep)[0] || null;
}

// ---------------------------------------------------------------------------
// 步骤 1：从 app 求根集（入口组件）
// ---------------------------------------------------------------------------
function collectRootComponents(appDir, distRoot) {
  const roots = new Set();
  const skip = new Set([path.join(appDir, EMBED_NPM_DIR), path.join(appDir, 'node_modules')]);
  const jsonFiles = walkFiles(appDir, skip).filter((f) => f.endsWith('.json'));

  for (const jf of jsonFiles) {
    const json = readJsonSafe(jf);
    if (!json || typeof json !== 'object') continue;
    for (const ref of extractComponentRefs(json)) {
      const top = resolveTopLevelEntry(distRoot, jf, ref);
      if (top) roots.add(top);
    }
  }
  return roots;
}

/** 从一份 json 里抽取所有组件引用 value（usingComponents + componentGenerics 默认值） */
function extractComponentRefs(json) {
  const refs = [];
  const uc = json.usingComponents;
  if (uc && typeof uc === 'object') {
    for (const v of Object.values(uc)) if (typeof v === 'string') refs.push(v);
  }
  const cg = json.componentGenerics;
  if (cg && typeof cg === 'object') {
    for (const v of Object.values(cg)) {
      // generics 可能是 true 或 { default: "path" }
      if (v && typeof v === 'object' && typeof v.default === 'string') refs.push(v.default);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 步骤 2：BFS 传递闭包（组件 → 组件，经 dist 内组件 json）
// ---------------------------------------------------------------------------
function expandComponentClosure(distRoot, roots) {
  const kept = new Set([...roots].filter((r) => !r.startsWith(`${EMBED_NPM_DIR}/`)));
  const queue = [...kept];
  while (queue.length) {
    const comp = queue.shift();
    const compDir = path.join(distRoot, comp);
    if (!isDir(compDir)) continue;
    // 该组件目录内所有 json（含嵌套子组件 json，如 chat-markdown/xxx-node/xxx-node.json）
    const jsons = walkFiles(compDir).filter((f) => f.endsWith('.json'));
    for (const jf of jsons) {
      const json = readJsonSafe(jf);
      if (!json || typeof json !== 'object') continue;
      for (const ref of extractComponentRefs(json)) {
        const top = resolveTopLevelEntry(distRoot, jf, ref);
        if (!top || top.startsWith(`${EMBED_NPM_DIR}/`)) continue;
        if (ALWAYS_KEEP.has(top)) continue;
        if (!kept.has(top)) {
          kept.add(top);
          queue.push(top);
        }
      }
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// 步骤 4：内嵌依赖闭包（保留文件对 dist 根下其它顶层条目/内嵌 npm 的引用）
// ---------------------------------------------------------------------------
const IMPORT_RE =
  /(?:require\s*\(|import\s*\(|import\s*[^'"]*?\bfrom\s*|import\s*|@import\s+|<wxs[^>]*\bsrc\s*=\s*)['"]([^'"]+)['"]/g;
const WXS_SRC_RE = /\bsrc\s*=\s*['"]([^'"]+)['"]/g;

function scanFileRefs(distRoot, file) {
  const text = readTextSafe(file);
  const tops = new Set();
  const shared = new Set();
  const take = (ref) => {
    const top = resolveTopLevelEntry(distRoot, file, ref);
    if (top) tops.add(top);
    const sub = resolveSharedSubdir(distRoot, file, ref);
    if (sub) shared.add(sub);
  };
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text)) !== null) take(m[1]);
  // wxml 里的 <wxs src> 与 <import src>，单独扫一遍 src=
  if (file.endsWith('.wxml')) {
    WXS_SRC_RE.lastIndex = 0;
    while ((m = WXS_SRC_RE.exec(text)) !== null) take(m[1]);
  }
  return { tops, shared };
}

/** 列出 common/shared 下所有子目录名 */
function listSharedSubdirs(distRoot) {
  const sharedRoot = path.join(distRoot, 'common', 'shared');
  if (!isDir(sharedRoot)) return [];
  return fs
    .readdirSync(sharedRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function listTopDirs(root) {
  if (!isDir(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * 内嵌依赖闭包（迭代到不动点）。同时计算：
 *  - keptTop：需保留的 dist 顶层条目（含 miniprogram_npm/<lib>）
 *  - keptShared：需保留的 common/shared/<name> 子目录名
 * shared 子目录保留判定 = 与保留组件同名（初始假设） ∪ 被保留文件真实 @import/require 引用到。
 * 扫描时 common/shared 仅扫"已判定保留"的子目录，其余 shared 子目录不参与（避免被删代码反向拉回依赖）。
 */
function expandEmbedClosure(distRoot, keptComponents) {
  // 起始保留集 = 保留组件 + 始终保留目录
  const keptTop = new Set(keptComponents);
  for (const k of ALWAYS_KEEP) {
    if (isDir(path.join(distRoot, k))) keptTop.add(k);
  }

  const allShared = listSharedSubdirs(distRoot);
  // 初始保留的 shared 子目录：与保留组件同名
  const keptShared = new Set(allShared.filter((n) => keptComponents.has(n)));
  const sharedRoot = path.join(distRoot, 'common', 'shared');

  // 待扫描目录（顶层），common 目录单独按 keptShared 细粒度处理
  const scanDirs = new Set();
  for (const k of keptTop) {
    if (k !== 'common') scanDirs.add(path.join(distRoot, k));
  }

  // 收集本轮待扫描文件：scanDirs 全量 + common 下"非 shared 内容 + keptShared 子目录"
  const collectFiles = () => {
    const files = [];
    for (const d of scanDirs) {
      if (!isDir(d)) continue;
      files.push(...walkFiles(d));
    }
    const commonDir = path.join(distRoot, 'common');
    if (isDir(commonDir)) {
      // common 下除 shared 外的内容
      files.push(...walkFiles(commonDir, new Set([sharedRoot])));
      // 仅保留的 shared 子目录
      for (const name of keptShared) {
        const sub = path.join(sharedRoot, name);
        if (isDir(sub)) files.push(...walkFiles(sub));
      }
    }
    return files;
  };

  // 迭代到不动点
  let changed = true;
  while (changed) {
    changed = false;
    const files = collectFiles();
    for (const f of files) {
      const { tops, shared } = scanFileRefs(distRoot, f);
      for (const top of tops) {
        if (!keptTop.has(top)) {
          keptTop.add(top);
          changed = true;
        }
        const topDir = path.join(distRoot, top);
        if (topDir !== path.join(distRoot, 'common') && isDir(topDir) && !scanDirs.has(topDir)) {
          scanDirs.add(topDir);
          changed = true;
        }
      }
      for (const name of shared) {
        if (allShared.includes(name) && !keptShared.has(name)) {
          keptShared.add(name);
          changed = true;
        }
      }
    }
  }
  return { keptTop, keptShared };
}

// ---------------------------------------------------------------------------
// icon.wxss 子集
// ---------------------------------------------------------------------------
const ICON_CLASS_RE = /\.t-icon-([a-z0-9-]+):before/g;
const QUOTED_TOKEN_RE = /['"]([a-z0-9]+(?:-[a-z0-9]+)*)['"]/g;
const ICON_RULE_RE = /\.t-icon-([a-z0-9-]+):before\{[^}]*\}/g;

function parseKnownIconNames(wxss) {
  const names = new Set();
  ICON_CLASS_RE.lastIndex = 0;
  let m;
  while ((m = ICON_CLASS_RE.exec(wxss)) !== null) names.add(m[1]);
  return names;
}

function collectQuotedTokens(text) {
  const tokens = [];
  QUOTED_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = QUOTED_TOKEN_RE.exec(text)) !== null) tokens.push(m[1]);
  return tokens;
}

function collectUsedIconNames(files, known) {
  const used = new Set();
  for (const file of files) {
    if (!/\.(wxml|js|ts|json|wxs)$/.test(file)) continue;
    const text = readTextSafe(file);
    for (const token of collectQuotedTokens(text)) {
      if (known.has(token)) used.add(token);
    }
  }
  return used;
}

function listIconScanFiles(appDir, distRoot, keepDirs) {
  const files = [];
  const appSkip = new Set([path.join(appDir, EMBED_NPM_DIR), path.join(appDir, 'node_modules')]);
  files.push(...walkFiles(appDir, appSkip));
  for (const name of keepDirs) {
    const dir = path.join(distRoot, name);
    if (isDir(dir)) files.push(...walkFiles(dir));
  }
  return files;
}

function buildPrunedIconWxss(original, used) {
  ICON_RULE_RE.lastIndex = 0;
  return original.replace(ICON_RULE_RE, (full, name) => (used.has(name) ? full : ''));
}

function resolveIconPlan(appDir, distRoot, keepDirs, pruneIcons) {
  const iconWxss = path.join(distRoot, ICON_WXSS_REL);
  if (!pruneIcons || !exists(iconWxss)) {
    return { enabled: false, used: new Set(), knownCount: 0, originalBytes: 0 };
  }
  const original = readTextSafe(iconWxss);
  const known = parseKnownIconNames(original);
  if (known.size === 0) {
    return { enabled: false, used: new Set(), knownCount: 0, originalBytes: original.length };
  }
  const used = collectUsedIconNames(listIconScanFiles(appDir, distRoot, keepDirs), known);
  return {
    enabled: used.size > 0,
    used,
    knownCount: known.size,
    originalBytes: original.length,
  };
}

function applyIconPrune(outRoot, iconPlan) {
  const iconWxss = path.join(outRoot, ICON_WXSS_REL);
  if (!iconPlan.enabled || !exists(iconWxss)) return 0;
  const original = readTextSafe(iconWxss);
  const pruned = buildPrunedIconWxss(original, iconPlan.used);
  fs.writeFileSync(iconWxss, pruned);
  return original.length - pruned.length;
}

// ---------------------------------------------------------------------------
// 裁剪计划
// ---------------------------------------------------------------------------
function buildPlan(appDir, distRoot, options) {
  const roots = collectRootComponents(appDir, distRoot);
  const keptComponents = expandComponentClosure(distRoot, roots);

  if (keptComponents.size === 0 && !options.force) {
    console.error(
      `[error] 未从 --app 解析到任何落在 dist 内的 tdesign 组件引用（根集为空）。\n` +
        `        这通常意味着 --app 路径不对、--lib 包名不匹配，或 app 未使用该库。\n` +
        `        为避免误删整个 dist，已中止。确认无误可加 --force 强制执行。`,
    );
    process.exit(1);
  }

  const { keptTop, keptShared } = expandEmbedClosure(distRoot, keptComponents);
  const sharedRoot = path.join(distRoot, 'common', 'shared');
  const sharedDropRel = listSharedSubdirs(distRoot)
    .filter((n) => !keptShared.has(n))
    .map((n) => path.join('common', 'shared', n))
    .sort();

  const topEntries = fs.readdirSync(distRoot, { withFileTypes: true });
  const keepDirs = [];
  const deleteDirs = [];
  const deleteRootFiles = [];

  for (const e of topEntries) {
    if (e.isDirectory()) {
      if (e.name === EMBED_NPM_DIR) continue;
      if (ALWAYS_KEEP.has(e.name) || keptTop.has(e.name)) keepDirs.push(e.name);
      else deleteDirs.push(e.name);
    } else if (e.isFile() && REDUNDANT_FILE_NAMES.has(e.name)) {
      deleteRootFiles.push(e.name);
    }
  }

  const nestedRedundant = [];
  const nestedDts = [];
  const recordIfRedundant = (abs) => {
    const base = path.basename(abs);
    const rel = path.relative(distRoot, abs);
    if (REDUNDANT_FILE_NAMES.has(base)) nestedRedundant.push(rel);
    else if (hasRedundantSuffix(base)) nestedDts.push(rel);
  };
  for (const d of keepDirs) {
    for (const f of walkFiles(path.join(distRoot, d))) recordIfRedundant(f);
  }
  const embedRootForDts = path.join(distRoot, EMBED_NPM_DIR);
  if (isDir(embedRootForDts)) {
    for (const name of fs.readdirSync(embedRootForDts)) {
      if (!keptTop.has(`${EMBED_NPM_DIR}/${name}`)) continue;
      const sub = path.join(embedRootForDts, name);
      if (isDir(sub)) {
        for (const f of walkFiles(sub)) recordIfRedundant(f);
      } else {
        recordIfRedundant(sub);
      }
    }
  }
  for (const e of topEntries) {
    if (e.isFile()) recordIfRedundant(path.join(distRoot, e.name));
  }

  const embedKeep = [];
  const embedDelete = [];
  const embedRoot = path.join(distRoot, EMBED_NPM_DIR);
  if (isDir(embedRoot)) {
    for (const e of fs.readdirSync(embedRoot, { withFileTypes: true })) {
      const tag = `${EMBED_NPM_DIR}/${e.name}`;
      if (keptTop.has(tag)) embedKeep.push(e.name);
      else embedDelete.push(e.name);
    }
  }

  const totalComponentDirs = topEntries.filter(
    (e) => e.isDirectory() && e.name !== EMBED_NPM_DIR && !ALWAYS_KEEP.has(e.name),
  ).length;

  const iconPlan = resolveIconPlan(appDir, distRoot, keepDirs, options.pruneIcons);

  return {
    keptComponents,
    keptTop,
    keptShared,
    keepDirs: keepDirs.sort(),
    deleteDirs: deleteDirs.sort(),
    deleteRootFiles,
    nestedRedundant: nestedRedundant.sort(),
    nestedDts: nestedDts.sort(),
    embedKeep: embedKeep.sort(),
    embedDelete: embedDelete.sort(),
    sharedDropRel,
    totalComponentDirs,
    iconPlan,
  };
}

function tallyPath(p) {
  let files = 0;
  let bytes = 0;
  if (isDir(p)) {
    for (const f of walkFiles(p)) {
      files += 1;
      bytes += fileSize(f);
    }
  } else if (exists(p)) {
    files += 1;
    bytes += fileSize(p);
  }
  return { files, bytes };
}

function printPlan(plan) {
  log('=== 保留组件闭包 (' + plan.keptComponents.size + ') ===');
  log([...plan.keptComponents].sort().join(', '));
  log('');
  log('=== 始终保留共享目录 ===');
  log(plan.keepDirs.filter((k) => ALWAYS_KEEP.has(k)).join(', ') || '(无)');
  log('');
  log('=== 保留内嵌 npm (' + plan.embedKeep.length + ') ===');
  log(plan.embedKeep.join(', ') || '(无)');
  log('');
  log('=== 将删除组件目录 (' + plan.deleteDirs.length + ') ===');
  log(plan.deleteDirs.join(', ') || '(无)');
  log('');
  log('=== 将删除内嵌 npm (' + plan.embedDelete.length + ') ===');
  log(plan.embedDelete.join(', ') || '(无)');
  log('');
  log('=== 将删除 common/shared 子目录 (' + plan.sharedDropRel.length + ') ===');
  log(plan.sharedDropRel.join(', ') || '(无)');
  log('');
  log('=== 将删除根级冗余文件 ===');
  log(plan.deleteRootFiles.join(', ') || '(无)');
  log('');
  log('=== 将删除嵌套冗余文件 (' + plan.nestedRedundant.length + ') ===');
  log(plan.nestedRedundant.join(', ') || '(无)');
  log('');
  log('=== 将删除 *.d.ts (' + plan.nestedDts.length + ') ===');
  log(plan.nestedDts.length ? `${plan.nestedDts.length} 个类型声明` : '(无)');
  log('');
  if (plan.iconPlan.enabled) {
    log(
      `=== icon.wxss 子集：${plan.iconPlan.knownCount} → ${plan.iconPlan.used.size} 个图标 class ===`,
    );
    log([...plan.iconPlan.used].sort().join(', '));
  } else if (!plan.iconPlan.knownCount) {
    log('=== icon.wxss 子集：跳过（无 icon.wxss 或未开启） ===');
  } else {
    log('=== icon.wxss 子集：跳过（未解析到任何图标名，保留全量以防误删） ===');
  }
  log('');
  log(
    `=== 删除占比：组件目录 ${plan.deleteDirs.length}/${plan.totalComponentDirs}` +
      `，内嵌 npm ${plan.embedDelete.length}/${plan.embedKeep.length + plan.embedDelete.length} ===`,
  );
  log('');
}

function collectDeleteTargets(distRoot, plan) {
  const targets = [];
  for (const d of plan.deleteDirs) targets.push(path.join(distRoot, d));
  const embedRoot = path.join(distRoot, EMBED_NPM_DIR);
  for (const e of plan.embedDelete) targets.push(path.join(embedRoot, e));
  for (const s of plan.sharedDropRel) targets.push(path.join(distRoot, s));
  for (const f of plan.deleteRootFiles) targets.push(path.join(distRoot, f));
  for (const f of plan.nestedRedundant) targets.push(path.join(distRoot, f));
  for (const f of plan.nestedDts) targets.push(path.join(distRoot, f));
  return targets;
}

function writeManifest(outRoot, plan, extra = {}) {
  const manifest = {
    lib: extra.lib || 'tdesign-miniprogram',
    keptComponents: [...plan.keptComponents].sort(),
    keptDirs: plan.keepDirs,
    deletedComponents: plan.deleteDirs,
    keptEmbed: plan.embedKeep,
    deletedEmbed: plan.embedDelete,
    keptShared: [...plan.keptShared].sort(),
    deletedShared: plan.sharedDropRel,
    keptIcons: [...plan.iconPlan.used].sort(),
    iconWxssPruned: Boolean(plan.iconPlan.enabled),
    ...extra,
  };
  fs.writeFileSync(path.join(outRoot, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
}

function diffSorted(actual, expected) {
  const extra = actual.filter((n) => !expected.has(n));
  const missing = [...expected].filter((n) => !actual.includes(n));
  return { extra, missing };
}

function checkExisting(checkDir, plan) {
  if (!isDir(checkDir)) {
    console.error(`[error] --check 不是有效目录：${checkDir}`);
    process.exit(1);
  }

  const problems = [];
  const actualDirs = listTopDirs(checkDir).filter((n) => n !== EMBED_NPM_DIR);
  const expectedDirs = new Set(plan.keepDirs);
  const dirDiff = diffSorted(actualDirs, expectedDirs);
  if (dirDiff.extra.length) {
    problems.push(`多余组件/目录（未裁剪或被「构建 npm」覆盖）：${dirDiff.extra.join(', ')}`);
  }
  if (dirDiff.missing.length) {
    problems.push(`缺少应保留目录：${dirDiff.missing.join(', ')}`);
  }

  const actualEmbed = listTopDirs(path.join(checkDir, EMBED_NPM_DIR));
  const expectedEmbed = new Set(plan.embedKeep);
  const embedDiff = diffSorted(actualEmbed, expectedEmbed);
  if (embedDiff.extra.length) {
    problems.push(`多余内嵌 npm：${embedDiff.extra.join(', ')}`);
  }
  if (embedDiff.missing.length) {
    problems.push(`缺少内嵌 npm：${embedDiff.missing.join(', ')}`);
  }

  const actualShared = listSharedSubdirs(checkDir);
  const expectedShared = plan.keptShared;
  const sharedDiff = diffSorted(actualShared, expectedShared);
  if (sharedDiff.extra.length) {
    problems.push(`多余 common/shared 子目录：${sharedDiff.extra.join(', ')}`);
  }

  const checkIconWxss = path.join(checkDir, ICON_WXSS_REL);
  if (plan.iconPlan.enabled && exists(checkIconWxss)) {
    const actualIcons = parseKnownIconNames(readTextSafe(checkIconWxss));
    const extraIcons = [...actualIcons].filter((n) => !plan.iconPlan.used.has(n));
    const stillFull = actualIcons.size >= plan.iconPlan.knownCount && extraIcons.length > 0;
    if (stillFull || extraIcons.length > ICON_EXTRA_FAIL_THRESHOLD) {
      problems.push(
        `icon.wxss 未按需裁剪：现有 ${actualIcons.size} 个 class，按 app 只需 ${plan.iconPlan.used.size}（多余 ${extraIcons.length}）`,
      );
    }
  }

  if (problems.length) {
    console.error('[error] --check 失败：已有产物与当前 app 的裁剪闭包不一致。');
    for (const p of problems) console.error(`        - ${p}`);
    console.error('        不要用微信开发者工具「构建 npm」覆盖裁剪产物；请重新运行裁剪。');
    process.exit(1);
  }

  log('[CHECK] 已有产物与裁剪闭包一致');
  log(`[CHECK] 组件目录 ${actualDirs.length}，内嵌 npm ${actualEmbed.length}，icon class ${plan.iconPlan.used.size}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.app || !args.src || (!args.out && !args.check)) {
    usage();
    process.exit(1);
  }
  const appDir = path.resolve(args.app);
  const srcRoot = path.resolve(args.src);
  const outRoot = args.out ? path.resolve(args.out) : '';
  const checkDir = args.check ? path.resolve(args.check) : '';

  if (!isDir(appDir)) {
    console.error(`[error] --app 不是有效目录：${appDir}`);
    process.exit(1);
  }
  if (!isDir(srcRoot)) {
    console.error(`[error] --src 不是有效目录：${srcRoot}`);
    process.exit(1);
  }

  LIB_MARKERS = [`${args.lib}/`];

  log(`app  = ${appDir}`);
  log(`src  = ${srcRoot}`);
  if (outRoot) log(`out  = ${outRoot}`);
  if (checkDir) log(`check= ${checkDir}`);
  log(`lib  = ${args.lib}`);
  if (checkDir) log('mode = CHECK（只断言，不写文件）');
  else log(`mode = ${args.dryRun ? 'DRY-RUN（不写 out，不删文件）' : 'WRITE（写入 out 并裁剪）'}`);
  log('');

  const plan = buildPlan(appDir, srcRoot, { force: args.force, pruneIcons: args.pruneIcons });
  printPlan(plan);

  if (checkDir) {
    checkExisting(checkDir, plan);
    return;
  }

  const targets = collectDeleteTargets(srcRoot, plan);
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const t of targets) {
    const { files, bytes } = tallyPath(t);
    deletedFiles += files;
    deletedBytes += bytes;
  }

  if (args.dryRun) {
    log(`[DRY-RUN] 将删除 ${deletedFiles} 个文件，约 ${kb(deletedBytes)} KB`);
    log(`[DRY-RUN] 保留 ${plan.keepDirs.length} 个组件/共享目录 + ${plan.embedKeep.length} 个内嵌库`);
    if (plan.iconPlan.enabled) {
      log(
        `[DRY-RUN] icon.wxss 将保留 ${plan.iconPlan.used.size}/${plan.iconPlan.knownCount} 个图标 class`,
      );
    }
    return;
  }

  const writtenRoot = prepareOutputDir(srcRoot, outRoot);
  const writeTargets = collectDeleteTargets(writtenRoot, plan);
  for (const t of writeTargets) {
    try {
      fs.rmSync(t, { recursive: true, force: true });
    } catch (err) {
      warn(`删除失败：${t} (${err.message})`);
    }
  }

  const iconSaved = applyIconPrune(writtenRoot, plan.iconPlan);
  writeManifest(writtenRoot, plan, { lib: args.lib });

  let remainFiles = 0;
  let remainBytes = 0;
  for (const f of walkFiles(writtenRoot)) {
    remainFiles += 1;
    remainBytes += fileSize(f);
  }
  log(`[DONE] 已删除 ${deletedFiles} 个文件，约 ${kb(deletedBytes)} KB`);
  if (iconSaved > 0) log(`[DONE] icon.wxss 子集节省约 ${kb(iconSaved)} KB`);
  log(`[DONE] dist 剩余 ${remainFiles} 个文件，约 ${kb(remainBytes)} KB`);
}

main();
