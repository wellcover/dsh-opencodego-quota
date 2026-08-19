# dsh-opencodego-quota

DeepSeek Harness（DSH）Web GUI 的 **OpenCode Go 额度用量插件**：在页面左侧栏底部常驻一张小卡片，展示 **日（近5小时）/ 周 / 月** 三个窗口的额度使用进度条、已用金额 / 配额、重置时间，以及显式的**刷新时间**；自动刷新间隔默认 60 秒，点标题栏 ⚙（或底部秒数）在弹出的设置层里自由输入 5–3600 秒，回车或保存生效，持久化到浏览器 localStorage，卡片底部只显示当前秒数。

数据来自 OpenCode 官方用量接口 `GET https://opencode.ai/zen/go/v1/usage`（与官网仪表盘口径一致），非本地估算。

## 功能

- 📍 **左侧栏常驻卡片**：跟随 DSH 壳层渲染自动复位（MutationObserver 自愈），窄栏（图标栏）模式下自动隐藏
- 📊 **三窗口进度条**：`日 · 近5小时`（$12）、`周 · 本周`（$30）、`月 · 本月`（$60）
- 💰 每条显示已用百分比、已用美元 / 配额上限、重置时间（与官网一致）
- 🟢🟡🔴 剩余比例着色：剩余 >50% 绿 / 20–50% 黄 / <20% 红
- ⏱️ **DS 峰谷进度条**（v1.0.2）：按北京时间实时显示当前计费时段——高峰 09:00–12:00、14:00–18:00（琥珀色），其余为低谷（绿色）；24 小时色带 + 当前时刻标记，显示「高峰/低谷 · 时段区间（不含已过百分比）」，每 30 秒本地刷新
- ⏱️ **刷新时间**（v1.0.3）：卡片底部显示「刷新于 HH:MM:SS」与当前间隔秒数（如 `60s`，点击可打开设置）；标题栏 ⚙ 按钮弹出设置层，可输入 5–3600 秒，回车/保存生效、localStorage 持久化；⟳ 按钮手动刷新
- 🔑 **零配置取 Key**：自动从 DSH 凭据（`OPENCODE_GO_API_KEY`）读取，失败时回退到环境变量与 OpenCode CLI 的 `auth.json`
- 🔒 Key 仅经 HTTPS 发给官方接口（`Authorization: Bearer` + `x-api-key`）


<img width="246" height="264" alt="image" src="https://github.com/user-attachments/assets/dbc04827-1dca-4502-a8c4-df51d30c503f" />



## 安装

```bash
dsh plugin --profile web add github:wellcover/dsh-opencodego-quota
```


## 配置

无需额外配置；唯一前置条件：已配置 OpenCode Go API Key 且能在「设置 → 模型」中选择 `opencode-go` 提供商（当前默认 provider 即可）。

Key 解析顺序：

| 顺序 | 来源 |
| --- | --- |
| 1 | DSH 凭据 `OPENCODE_GO_API_KEY`（`~/.dsh/.credentials.yaml`） |
| 2 | 环境变量 `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` |
| 3 | `~/.local/share/opencode/auth.json`（`opencode-go`，回退 `opencode`，`type: "api"`） |

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 卡片显示「额度获取失败」 | 看工作区下 `opencodego-quota-boot.log`（宿主激活诊断）；确认 `cordis.patch.yml` 行存在且 `inject` 列表完整 |
| 「未找到 OpenCode Go API Key」 | 在设置 → 模型配置 API Key，或确认 `~/.dsh/.credentials.yaml` 有 `OPENCODE_GO_API_KEY` |
| 卡片不出现 | 插件未激活或 client 未加载：确认 profile `package.json` 的 `dsh.profile.bundles` 含本包名，重启后刷新页面 |
| 窄栏图标模式下卡片隐藏 | 设计如此：侧栏 <110px 时自动隐藏，展开侧栏即恢复 |


## 变更记录

- **v1.0.3**：刷新间隔改为标题栏 ⚙ 设置弹层调整（回车/保存生效），卡片底部不再显示输入框、只显示当前秒数（点击秒数也可打开设置）。
- **v1.0.2**：修复日/周进度条不显示的渲染 bug（`requestAnimationFrame` 闭包捕获循环尾值，导致除月条外全部停在 0%）；DS 峰谷状态去掉末尾「· 已过 %」百分比；刷新间隔可自定义（秒，5–3600，localStorage 持久化）。
- **v1.0.1**：新增 DS 峰谷（高峰/低谷计费时段）色带；v1.0.0：首个版本。

## License

MIT
