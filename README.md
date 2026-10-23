# dsh-virtual-coding-plan

一个跑在本机的「虚拟 coding plan」：按**人民币花费**记账，用 5 小时滚动窗口和自然周两个额度限制用量，达到上限后**当前这轮回复照常跑完**，下一轮开始前拒绝继续，直到窗口重置或你手动提额。

它不是任何厂商的订阅，也不连接任何第三方服务：只读本机会话日志里的 token 用量，按价目表折算成钱。

## 行为

- **记账**：监听 `session/event` 的 `assistant/message`，用 `usage` 按 DeepSeek 峰谷价算钱（缓存命中 / 未命中输入 / 输出三档分开计价，`reasoningTokens` 不重复计费）。
- **评估**：5 小时滚动窗口 + 自然周（北京时间周一 00:00）窗口，任一超限即视为「用尽」。
- **拦截**：只在 `agent/pre-step` 的 **step 1**（新一轮开始）拒绝，进行中的回复不会被打断。
- **展示**：输入框下方常驻状态条 `Coding Plan · 5h ◔10% · 周 ◔34% · 距离重置 ◔2h13m`，前两个环是该窗口的花费比例，最后一个环是窗口剩余时间；**点一下状态条**会打开含完整明细与提额的面板（同一份内容也在 设置 → 虚拟额度计划 里）。用尽时输入区还会出现提示条。

## 安装

在 Plugins 页安装，或：

```
plugin_manager install_bundle target:<本目录绝对路径>
```

本地目录以 link 方式装进 profile，改代码后重启 DSH 生效。

## 命令

| 命令 | 作用 |
|---|---|
| `/usage` | 打印各窗口已用/上限/重置时间与今日、本周合计 |
| `/usage on` / `/usage off` | 开/关拦截（关闭后仍继续记账） |
| `/usage topup <元>` | 给当前窗口提额，随窗口重置失效 |
| `/usage preset <id>` | 切换预设 |

在页面或 `/usage topup` 改过的额度会记为 override，优先于预设文件；切换预设会清空 override。

## 配置

写在 `cordis.patch.yml` 的 row `config` 里：

| 键 | 默认 | 说明 |
|---|---|---|
| `preset` | `simulated` | `presets/<id>.json` |
| `planFile` | 空 | 绝对路径，优先于 `preset`；指向自定义计划文件 |
| `enforcement` | `block` | `block` / `warn` / `off`，仅首次启动的默认值，之后以账本里保存的为准 |
| `ledgerFile` | `~/.dsh/.dshvcp-ledger.json` | 账本路径 |

## 计划文件

```json
{
  "id": "simulated",
  "name": "模拟 Plan",
  "currency": "CNY",
  "windows": [
    { "id": "session", "label": "5 小时", "short": "5h",
      "kind": "rolling", "durationMs": 18000000, "limitYuan": 5 },
    { "id": "weekly", "label": "本周", "short": "周",
      "kind": "calendar-week", "limitYuan": 30 }
  ]
}
```

`kind`：`rolling`（需要 `durationMs`）/ `calendar-day` / `calendar-week`，日与周边界都按北京时间。

### 换成真实第三方 plan

只需要把 `limitYuan` 改成那个 plan 的额度，不必改代码：把上面的 JSON 复制一份放进 `presets/`，用 `/usage preset <新 id>` 切换，或在 `config.planFile` 指向它。**金额由你自己填，插件不校验也不背书这些数字**。

## 路由

- `GET /dsh-virtual-coding-plan/status.json` — 状态条与页面读取的聚合数据（只有金额与计数，没有对话内容）。
- `POST /dsh-virtual-coding-plan/settings.json` — `{ enforcement?, limits?, topup?, presetId? }`。

## 数据

`~/.dsh/.dshvcp-ledger.json`：`events`（每步花费，最多 14 天 / 20000 条）、`settings`（限额覆盖与模式）。原子写入（临时文件 + rename），文件损坏会备份成 `.corrupt-<时间戳>` 后重新开始。

**临时额度不进账本**：提额后的额度只存在于内存，写文件时剔除、读取时忽略——重启 DSH 或重载插件后，上限回到预设（或你覆盖过的）基础值。这是有意的：临时额度属于「这一次」，不是配置。

## 已知限制

- 不回填安装之前的花费。
- 假定同一时刻只有一台机器、一个 Host 进程写这个账本。
- 法定节假日表目前覆盖 2026 年；每年 11 月需要随国务院安排补下一年（在 `pricing.mjs` 的 `HOLIDAY_VALLEY`）。
- 价目表里没有的模型按 `_default`（Flash 价）估算，账本事件标 `priced:false`，页面上显示「≈」。
- 拦截的表现是「新一轮被拒绝」；可读提示由状态条与输入区提示条承担。
- 子代理会话的首个 step 也会被拒——额度用尽时停止花钱比让子代理跑完更重要。

## 开发

```
node --test test/pricing.test.mjs
```

`pricing.mjs` 是纯函数（不读时钟、不碰 IO），测试用注入的 `nowMs` 覆盖峰谷取价、周/日边界、滚动窗口重置、提额与过期、裁剪与去重。

## 价目表来源

价目表、峰谷规则、节假日表与金额单位移植自 **dsh-whale-widget v0.4.2**（MIT），详见 `THIRD_PARTY_NOTICES.md`。移植保持语义不变，这样同一轮对话在本插件与余额挂件里显示的是同一个价。

## 许可

MIT。
