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
 *
 *   --app      下游小程序源码根目录（含 app.json / pages / components 的 .json）
 *   --src      全量 tdesign dist 目录（只读）
 *   --out      输出裁剪后的 tdesign dist 目录（会先清空再写入）
 *   --lib      组件库 npm 包名（默认 tdesign-miniprogram，用于识别带库名前缀的引用）
 *   --dry-run  只打印将删除/保留清单，不写 out，不真正删
 *   --force    跳过"根集为空"安全护栏（谨慎使用，可能删光整个 dist）
 *
 * 算法：
 *   1. 求根集：扫描 app 下所有 .json（排除其 miniprogram_npm/）的 usingComponents /
 *      componentGenerics，凡 value 解析后落在 dist 内的，取其顶层组件目录名为根。
 *      根集为空时默认中止（防止误删整个库），可用 --force 强制继续。
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
 *
 * 仅用 Node 内置模块，node 直接可跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI 解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { app: '', src: '', out: '', dryRun: false, force: false, lib: 'tdesign-miniprogram' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--app') args.app = argv[++i];
    else if (a === '--src') args.src = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--lib') args.lib = argv[++i];
    else if (a === '--dry-run' || a === '--dryRun') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  console.log(
    'Usage: node tree-shake.mjs --app <appMiniprogramDir> --src <fullDistDir> --out <prunedDistDir> [--lib <pkgName>] [--dry-run] [--force]',
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

function prepareOutputDir(srcRoot, outRoot, dryRun) {
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
  if (dryRun) return normSrc;

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
  const skip = new Set([path.join(appDir, EMBED_NPM_DIR)]);
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
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.app || !args.src || !args.out) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const appDir = path.resolve(args.app);
  const srcRoot = path.resolve(args.src);
  const outRoot = path.resolve(args.out);

  if (!isDir(appDir)) {
    console.error(`[error] --app 不是有效目录：${appDir}`);
    process.exit(1);
  }
  if (!isDir(srcRoot)) {
    console.error(`[error] --src 不是有效目录：${srcRoot}`);
    process.exit(1);
  }
  const distRoot = prepareOutputDir(srcRoot, outRoot, args.dryRun);

  LIB_MARKERS = [`${args.lib}/`];

  log(`app  = ${appDir}`);
  log(`src  = ${srcRoot}`);
  log(`out  = ${outRoot}`);
  log(`lib  = ${args.lib}`);
  log(`mode = ${args.dryRun ? 'DRY-RUN（不写 out，不删文件）' : 'WRITE（写入 out 并裁剪）'}`);
  log('');

  // 1. 根集
  const roots = collectRootComponents(appDir, distRoot);
  // 2. 组件传递闭包
  const keptComponents = expandComponentClosure(distRoot, roots);

  // 安全护栏：根集为空说明 --app 路径/包名很可能配错，继续执行会删光整个库
  if (keptComponents.size === 0 && !args.force) {
    console.error(
      `[error] 未从 --app 解析到任何落在 dist 内的 tdesign 组件引用（根集为空）。\n` +
        `        这通常意味着 --app 路径不对、--lib 包名不匹配，或 app 未使用该库。\n` +
        `        为避免误删整个 dist，已中止。确认无误可加 --force 强制执行。`,
    );
    process.exit(1);
  }

  // 4. 内嵌依赖闭包（含 miniprogram_npm/<lib>）+ shared 子目录保留判定
  const { keptTop, keptShared } = expandEmbedClosure(distRoot, keptComponents);

  // common/shared 待删子目录 = 全部 shared 子目录 - 已判定保留
  const sharedRoot = path.join(distRoot, 'common', 'shared');
  const sharedDrop = new Set(
    listSharedSubdirs(distRoot)
      .filter((n) => !keptShared.has(n))
      .map((n) => path.join(sharedRoot, n)),
  );

  // dist 顶层条目
  const topEntries = fs.readdirSync(distRoot, { withFileTypes: true });

  const keepDirs = [];
  const deleteDirs = [];
  const deleteRootFiles = [];

  for (const e of topEntries) {
    if (e.isDirectory()) {
      if (e.name === EMBED_NPM_DIR) {
        // 内嵌 npm 容器：逐个子库按 keptTop(miniprogram_npm/<lib>) 决定
        continue;
      }
      if (ALWAYS_KEEP.has(e.name) || keptTop.has(e.name)) keepDirs.push(e.name);
      else deleteDirs.push(e.name);
    } else if (e.isFile() && REDUNDANT_FILE_NAMES.has(e.name)) {
      // 根级冗余文件删除；其余根级工具文件（.json/.js/.ts/索引等）一律保留
      deleteRootFiles.push(e.name);
    }
  }

  // #2：保留目录内任意层级的开发期冗余文件也要删（顶层遍历覆盖不到嵌套层）
  const nestedRedundant = [];
  for (const d of keepDirs) {
    for (const f of walkFiles(path.join(distRoot, d))) {
      if (REDUNDANT_FILE_NAMES.has(path.basename(f))) nestedRedundant.push(f);
    }
  }

  // 内嵌 npm 子库
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

  // common/shared 待删子目录（相对展示）
  const sharedDropRel = [...sharedDrop].map((p) => path.relative(distRoot, p)).sort();

  // ----- 统计与输出 -----
  let deletedBytes = 0;
  let deletedFiles = 0;
  const tally = (p) => {
    // 单次遍历同时累加大小与文件数（避免对每个目标重复 walk）
    if (isDir(p)) {
      for (const f of walkFiles(p)) {
        deletedFiles += 1;
        try {
          deletedBytes += fs.statSync(f).size;
        } catch {
          /* ignore */
        }
      }
    } else {
      deletedFiles += 1;
      try {
        deletedBytes += fs.statSync(p).size;
      } catch {
        /* ignore */
      }
    }
  };

  const totalComponentDirs = topEntries.filter(
    (e) => e.isDirectory() && e.name !== EMBED_NPM_DIR && !ALWAYS_KEEP.has(e.name),
  ).length;

  log('=== 保留组件闭包 (' + keptComponents.size + ') ===');
  log([...keptComponents].sort().join(', '));
  log('');
  log('=== 始终保留共享目录 ===');
  log([...ALWAYS_KEEP].filter((k) => isDir(path.join(distRoot, k))).join(', '));
  log('');
  log('=== 保留内嵌 npm (' + embedKeep.length + ') ===');
  log(embedKeep.sort().join(', ') || '(无)');
  log('');
  log('=== 将删除组件目录 (' + deleteDirs.length + ') ===');
  log(deleteDirs.sort().join(', ') || '(无)');
  log('');
  log('=== 将删除内嵌 npm (' + embedDelete.length + ') ===');
  log(embedDelete.sort().join(', ') || '(无)');
  log('');
  log('=== 将删除 common/shared 子目录 (' + sharedDropRel.length + ') ===');
  log(sharedDropRel.join(', ') || '(无)');
  log('');
  log('=== 将删除根级冗余文件 ===');
  log(deleteRootFiles.join(', ') || '(无)');
  log('');
  log('=== 将删除嵌套冗余文件 (' + nestedRedundant.length + ') ===');
  log(
    nestedRedundant
      .map((f) => path.relative(distRoot, f))
      .sort()
      .join(', ') || '(无)',
  );
  log('');
  log(
    `=== 删除占比：组件目录 ${deleteDirs.length}/${totalComponentDirs}` +
      `，内嵌 npm ${embedDelete.length}/${embedKeep.length + embedDelete.length} ===`,
  );
  log('');

  // 收集待删绝对路径
  const targets = [];
  for (const d of deleteDirs) targets.push(path.join(distRoot, d));
  for (const e of embedDelete) targets.push(path.join(embedRoot, e));
  for (const s of sharedDrop) targets.push(s);
  for (const f of deleteRootFiles) targets.push(path.join(distRoot, f));
  for (const f of nestedRedundant) targets.push(f);

  for (const t of targets) tally(t);

  if (args.dryRun) {
    log(`[DRY-RUN] 将删除 ${deletedFiles} 个文件，约 ${kb(deletedBytes)} KB`);
    log(`[DRY-RUN] 保留 ${keepDirs.length} 个组件/共享目录 + ${embedKeep.length} 个内嵌库`);
    return;
  }

  for (const t of targets) {
    try {
      fs.rmSync(t, { recursive: true, force: true });
    } catch (err) {
      warn(`删除失败：${t} (${err.message})`);
    }
  }

  // 删除后统计 dist 剩余（单次遍历）
  let remainFiles = 0;
  let remainBytes = 0;
  for (const f of walkFiles(distRoot)) {
    remainFiles += 1;
    try {
      remainBytes += fs.statSync(f).size;
    } catch {
      /* ignore */
    }
  }
  log(`[DONE] 已删除 ${deletedFiles} 个文件，约 ${kb(deletedBytes)} KB`);
  log(`[DONE] dist 剩余 ${remainFiles} 个文件，约 ${kb(remainBytes)} KB`);
}

main();
