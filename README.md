# dsh-simple-tps

每一轮回答结束后，在 DSH 网页版的动作行里、分支按钮之后、自带的「用量」胶囊之前，显示这一轮的 **TTFT** 和 **TPS**。

```
[复制] [分支] [首字 3.2s · 均 2.1s · 42.6 tok/s] [⛁ 用量 12.3k] [18:42]
```

宿主 + 前端两半：宿主注册一个会话投影（`turnTimings`）从完整事件日志算每轮指标，前端只负责读取和排版。

## 架构：为什么宿主算而不是前端算

| | 前端算 | 宿主算（现在） |
|---|---|---|
| 数据来源 | 当前窗口的节点 `timing` | 完整事件日志 |
| 首字时间 | 刷新后丢失（`live-chunk` 不持久化） | 从 `assistant/message.data.stream` 还原 |
| 分页/压缩 | 老轮次算不出 | 不受影响 |

关键点：持久日志里 `assistant/live-chunk` 是 0 条（首字时间不在那儿），但每条 `assistant/message` 都带 `data.stream`。把里面的「基准时间 `time0` + 每 token 间隔 `dt[]`」重放一遍，就能精确还原任意 token 出现的时刻——包括第一个。这套逻辑和 DSH 自带的 `sessionStats` 投影用的是同一个事件、同一套语义。

前端仍保留一个窗口折叠作为兜底：万一投影不可用（旧版本宿主），退回读节点 `timing`。

## 口径

每一轮可能包含多个助手步骤（中间调工具），所以：

- **首字**：第一步的 TTFT —— 首 token 时间 − 该步开始时间，也就是「你按下回车之后等了多久它才开口」。
- **均**：所有记录了首 token 的步骤的算术平均；只有一步时两者相等，只显示一个。
- **tok/s**：按 token 加权，`Σ 输出 tokens ÷ Σ（消息完成时间 − 首 token 时间）`。逐步平均会让快而短的步骤权重过高，所以不用。
- 任一项拿不到就省略那一项（历史分页没覆盖到 `step/start`、模型没报 usage 等）；全拿不到就整条不渲染。
- **历史轮也能算准**（见上面的架构一节）。
- 万一某条消息的 stream 缺失（异常中断等），才退回「整步时长」算下界速度，显示成 `≈45.0 tok/s`。
- 窄屏降级：≤900px 去掉「均」，≤640px 只留 tok/s，≤480px 整条隐藏。

数据来源是聊天快照里每条已完成的助手节点上的 `timing`（`stepStartTime` / `firstTokenTime` / `completedTime`）、`usage.outputTokens`，以及 `data.stream` 里的逐 token 时间戳——前两组和自带「会话统计」用的是同一套字段，所以口径天然一致。

## 位置怎么来的

插槽只能贡献到「复制之后、分支之前」的位置，`用量 + 时间` 是动作行的最后一个子元素。所以位置靠 **CSS `order`** 实现：动作行是 flex 容器，不是 DOM 顺序决定视觉顺序。

```
[复制] [分支] [首字 3.2s · 均 2.4s · 50.0 tok/s] [⛁ 用量] [14:10]
        ↑ 插槽初始座位                ↑ 挪到这里
```

宿主若改了结构，最坏情况是退回默认位置（分支之前），不会崩。

## 挂载点

注册在 `conversation.chat.assistant-actions` 列表插槽里。这个插槽在 DOM 上只能落在「复制之后、分支之前」，落不到「用量」和「时间」之间——那一格是 `MessageIconActions` 内联写死的（`endInfo` 里塞着用量胶囊和时钟），没有对外插槽。

最终视觉位置靠 CSS `order`：

```css
[data-clock=end] .dsh-simple-tps { order: 5 }   /* 后代选择器，不是子选择器 */
[data-clock=end] > :last-child   { order: 10 }
```

**这里用的是后代选择器（空格），不是子选择器（`>`）**：插槽会在动作行和 pill 之间插一层 `display: contents` 的容器，pill 因此是孙节点。子选择器匹配不到，这就是第一版位置没变的真正原因。`display: contents` 的元素不生成盒子，但**不影响选择器匹配**，所以后代选择器可以穿过它。

既不在 `endInfo` 里面，就也不受它的影响。因为处在动作行内，历史轮次上它和用量胶囊一样是悬停才淡入的，这是刻意的取舍。

## 安装

已经装进 `~/.dsh/profiles/web`：

- `package.json` 的 `dependencies` 里有 `"dsh-simple-tps": "link:../../../Code/VibeCoding/dsh-simple-tps"`
- `dsh.profile.bundles` 末尾加了 `dsh-simple-tps`
- `node_modules/dsh-simple-tps` 是指向本目录的软链

改 `lib/index.js`（宿主投影）**必须重启**；只改 `lib/client.js`（前端）刷页面即可：

```bash
dsh-restart      # 宿主侧改动
# Ctrl+F5        # 前端侧改动
```

之后的 `pnpm install` 会按 `link:` 重新建链，不需要额外操作；如果要正式交给 pnpm 管理，在 profile 目录执行 `pnpm install` 即可。

## 开发

`lib/client.js` 是手写的模块加载器格式，**没有构建步骤**：

```js
window.__ModuleLoader__.load({ id: 'dsh-simple-tps', factory: (require) => { ... } })
```

`id` 必须等于包名；`require` 只能取平台模块表里的包（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等）。

改完 `lib/client.js` → `dsh-restart` → 刷页面。没有热更新：客户端 HMR 只在从源码 checkout 跑 `pnpm run dev:web` 时重建 bundle。

离线自测（不需要 dsh）：

```bash
node tests/run.mjs    # 前端：注册、折叠、投影优先、窄屏、格式化
node tests/host.mjs   # 宿主：stream 还原、多步折叠、真实日志比对
```

`tests/host.mjs` 会用本机一条真实会话日志（存在时）跑完整折叠，断言几乎每轮都能拿到精确 TTFT——这比构造假数据更能反映真实事件载荷。

## 卸载

```bash
# 从 bundles 和 dependencies 里删掉两行，然后
rm ~/.dsh/profiles/web/node_modules/dsh-simple-tps
rm ~/.dsh/profiles/web/package.json.bak-simple-tps   # 备份，确认稳定后再删
dsh-restart
```

当时的备份在 `~/.dsh/profiles/web/package.json.bak-simple-tps`。
