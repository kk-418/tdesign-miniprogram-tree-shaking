# tdesign-miniprogram-tree-shaking

面向微信小程序的 TDesign 组件依赖闭包裁剪工具。它扫描下游小程序的
`usingComponents` 和 `componentGenerics`，从官方 `tdesign-miniprogram`
完整产物中生成只包含实际组件及其传递依赖的独立产物。

`lazyCodeLoading: requiredComponents` 只优化启动注入、不减包体积，所以必须物理删文件。

## 使用方式

```bash
node tree-shake.mjs \
  --app <小程序源码目录> \
  --src <tdesign-miniprogram/miniprogram_dist> \
  --out <裁剪产物目录> \
  --lib tdesign-miniprogram
```

- `--src` 始终只读，`--out` 会先清空再生成。
- `--out` 不能等于或位于 `--src` 内部。
- `--dry-run` 只输出裁剪清单，不生成产物。
- 根组件集合为空时默认中止；确认需要空产物时可显式使用 `--force`。
- 默认会按 app + 保留组件里出现的图标名字面量裁剪 `icon/icon.wxss`。不需要时加 `--no-prune-icons`。
- 产物根目录写入 `.tdesign-pruned.json`（保留/删除清单）。
- 同时删除 `.wechatide.ib.json` 与 `*.d.ts`（运行时不需要）。

### 断言已有产物已被裁剪

不要用微信开发者工具「构建 npm」覆盖裁剪产物，那会把全量 dist 拷回 `miniprogram_npm`。
用 `--check` 守门：

```bash
node tree-shake.mjs \
  --app <小程序源码目录> \
  --src <tdesign-miniprogram/miniprogram_dist> \
  --check <miniprogram_npm/tdesign-miniprogram>
```

多余组件目录、未裁剪的 `icon.wxss` 会以非零退出码失败。`--check` 不写文件，`--out` 可省略。

## 验证

```bash
npm test
```

本仓库作为 Git subtree 被消费端引入，不与 TDesign fork 或 npm 发布绑定。
