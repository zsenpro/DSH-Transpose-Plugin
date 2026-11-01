# DSH Transpose Plugin

把一段对话从一个工作区拖到另一个工作区，历史一起带走。DeepSeek Harness 的原生侧栏只支持工作区内排序，跨工作区没有入口。

包名 `@yg/dsh-session-mover`，作为 DSH 插件（Cordis bundle）安装。

## 用法

侧栏会话行上有两种拖拽，按发生顺序分流：

- **直接拖** → 原生排序。按住后鼠标一动就走浏览器自己的 HTML5 拖放，和没装插件时一样，会话在工作区内换位置。
- **按住不动 220ms 再拖** → 跨工作区搬家。长按成立后才接管这次手势，右侧浮出目标工作区列表，继续拖动并松手即完成搬迁。按 Esc 取消。

判定细节：按住不动 220ms 才算长按；这段时间内位移超过 12px 就判定为普通拖动，交回原生排序。

拖起后有两种投放目标：右侧浮层的卡片，或侧栏里的工作区行。成功后底部提示「已移动到 <工作区名>」，侧栏立刻刷新。只有一个工作区时不显示浮层。

## 原理

一段对话属于哪个工作区，由会话日志头部的 `cwd` 决定。移动一次要改三处，缺一处会话就会失联：

1. 把 `<sessions>/<旧 project 目录>/<id>/session.vN.jsonl.zstd` 搬到目标工作区对应的目录；
2. 重写日志首帧里的 `cwd`。只有首帧是 header，后面每一帧都是原始事件字节，直接拼接，不重新压缩；
3. 在 workspace registry 里把会话从旧工作区摘掉、挂到新工作区，并同步 registry 的 cwd 索引。

任何一步失败都会把日志搬回原处、把归属还原（包括把会话挂回原工作区，避免变成游离状态），接口返回 `attach-rejected` 并附回滚结果。

## 已知限制

**当前打开的会话，header 在内存里是冻结的。** 文件、目录、工作区归属都会被正确搬走，侧栏刷新后也会显示在新工作区下；但这个进程里该会话记录的工作目录仍是旧值，直到重启 DSH 才切换。接口返回值里的 `liveHeader: "frozen"` 就是这件事。

没在当前进程打开过的会话不受影响，文件和 `cwd` 完全一致。

## 安装

`package.json` 的 `name` 是 `@yg/dsh-session-mover`，`cordis.patch.yml` 插入的条目 id 是 `yg-session-mover`。

在 DSH 里让 `plugin_manager` 执行 `install_bundle`，target 指向本目录即可。安装后：

- 宿主半提供 `POST /yg-session-mover/api/move`（参数 `{ sessionId, targetWorkspaceId }`）与 `/api/peek`；
- 客户端半注册 `shell.overlay` 上的浮层；
- 每次调用追加一行到 `~/.dsh/yg-session-mover.log`。

改完客户端半必须让页面重新加载：桌面版没有刷新菜单，关掉窗口重新打开才会拉到新的 `__DSH_BOOT__` 图。

## 自检

`verify.js` 复制一份真实日志到临时目录，跑一遍搬迁、回滚、帧完整性、重复 id 拒绝，不碰真实数据。

```powershell
node verify.js
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
