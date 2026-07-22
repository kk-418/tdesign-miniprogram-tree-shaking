# tdesign-miniprogram-tree-shaking

面向微信小程序的 TDesign 组件依赖闭包裁剪工具。它扫描下游小程序的
`usingComponents` 和 `componentGenerics`，从官方 `tdesign-miniprogram`
完整产物中生成只包含实际组件及其传递依赖的独立产物。

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

## 验证

```bash
npm test
```

本仓库作为 Git subtree 被消费端引入，不与 TDesign fork 或 npm 发布绑定。
