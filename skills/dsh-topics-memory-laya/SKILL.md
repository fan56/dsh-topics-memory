---
name: dsh-topics-memory-laya
description: "为 dsh-topics-memory 的 jev 决策层安装并配置本地 laya 陪跑（laya-serve）。当用户要开启 jevLayaFallback、安装 laya、启动 laya-serve、配置 laya 端点、排查 laya 连接失败/陪跑不生效/decisions.jsonl 没有 laya 行时读本指南。覆盖：venv 创建、国内三镜像加速（清华 PyPI / hf-mirror / 禁 Xet）、checkpoint 下载、laya-serve 启动与自启、jevLayaFallback/jevLayaUrl 两键配置、真机验证（decisions.jsonl 出现 backend=laya 行）。触发词：laya、laya-serve、陪跑、本地决策、jevLaya、离线、8000 端口。"
---

# laya 本地陪跑安装与配置

> laya 是开源的 System One 决策引擎（本地推理，jev 的同范式替身）。topics-memory 的
> `jevLayaFallback: true` 会把每次 jev 调用并发一路本地 laya 请求作对照遥测。本指南把
> 安装配置一次讲完；全程不涉及付费 API。

## 前置检查（先判断要不要装）

1. `curl -s --max-time 3 -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8000/v1/systemone -H "content-type: application/json" -d '{"state":"w","questions":{"q":{"type":"noul","instructions":"w","criteria":{"true":"t","false":"f"}}}}'`
   返回 200 = laya-serve 已在跑，**跳到「插件配置」**；连接拒绝 = 继续安装。
2. `python3 --version` 需要 ≥ 3.10（3.13 以下优先，太新的版本 torch 轮子可能缺）。
3. 磁盘 ≥ 5GB（torch + 两个 checkpoint）。

## 安装（国内网络三件套必带，否则要么 100KB/s 要么挂死）

```bash
mkdir -p ~/laya-tryout && cd ~/laya-tryout
uv venv --python 3.12 .venv            # 没有 uv: brew install uv；或 python3 -m venv .venv
uv pip install --python .venv/bin/python \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple "laya[serve]" hf_transfer
```

下载 checkpoint（两个共 ~1.5GB）——三个环境变量一个都不能少：

```bash
export HF_ENDPOINT=https://hf-mirror.com    # HF 直连国内常 <50KB/s
export HF_HUB_DISABLE_XET=1                 # 新版 huggingface_hub 默认 Xet 协议，镜像不支持，会 0 字节挂死
export HF_HUB_ENABLE_HF_TRANSFER=1          # 并行分块，断流自动续传
.venv/bin/python -c "
from laya import Router
r = Router()
r.preload(['english', 'multilingual'])
print('checkpoints ok')
"
```

## 启动 laya-serve

```bash
LAYA_PRELOAD=1 LAYA_MODELS=english,multilingual ~/laya-tryout/.venv/bin/laya-serve
# binds 0.0.0.0:8000；进程前台跑，挂 nohup/tmux/launchd 由用户自选
```

- `LAYA_MODELS` 不设会尝试预载第三个 checkpoint（typed-decisions，再 +1.7GB）——陪跑用不到，别下。
- 自启（macOS launchd）可选：写 `~/Library/LaunchAgents/com.laya.serve.plist` 指向上面命令；不开自启就要接受「重启后陪跑静默失效」（无 laya = 毫秒级连接拒绝，无害但没对照数据）。

## 插件配置（在 profile patch 的 `dsh-topics-memory` 条目）

```yaml
config:
  jevEnabled: true          # 决策层总开关（本身默认关）
  jevLayaFallback: true     # laya 陪跑开关
  # jevLayaUrl 默认就是 http://127.0.0.1:8000/v1/systemone，不改端口不用写
```

前置：`jevEnabled: true` 且已按主配置指南配好 jev 后端 key（zen 免费档默认；key 走 patch `env:` 块或 `JEV_KEYCHAIN`——dsh 会清洗 ambient KEY 变量）。

## 验证（三步）

1. `curl -s -X POST http://127.0.0.1:8000/v1/systemone -H "content-type: application/json" -d '{"state":"w","model":"laya-rl-agent","questions":{"q":{"type":"noul","instructions":"w","criteria":{"true":"t","false":"f"}}}}' | jq .answers` — 返回 noul 概率即 laya 侧通。
2. 跑一轮真实会话（任意问题），然后：
   `jq -r 'select(.backend=="laya") | [.ref,.probability] | @tsv' ~/.dsh/topics/meta/decisions.jsonl | head` — 出现 `backend:"laya"` 的判定行 = 陪跑生效。
3. `~/.dsh/topics/meta/decisions.jsonl` 里同一 `digest` 应有成对的 primary/laya 行——这就是永久运行的 laya-vs-jev 对照数据。

## 语义边界（必须向用户讲清）

- laya 是**纯遥测对照，不参与决策**：真实负载实测其批内排序与 jev 一致率 0/14、负例分 0.63-0.76（绝对分不可用），主路失败照旧回退旧路径。
- 判定质量上 zen/typesafe 的 jev 系远胜 laya；laya 的价值是免费对照数据流 + 离线可用。
- laya 换语言（中→英）首次调用会触发 checkpoint 重载（数百 ms），陪跑场景无感。

## 常见坑速查

| 症状 | 原因 | 解法 |
|---|---|---|
| 下载 0 字节挂死 | Xet 协议 + 镜像不兼容 | `HF_HUB_DISABLE_XET=1` |
| checkpoint 下载 <100KB/s | HF 直连 | `HF_ENDPOINT=https://hf-mirror.com` |
| `z.string().volatile is not a function` 类插件报错 | （与 laya 无关）dsh 版本漂移 | 钉 0.1.7-rc 线，勿裸解析 |
| decisions.jsonl 无 backend=laya 行 | laya-serve 没起 / jevLayaFallback 没开 / jevEnabled 没开 | 按「验证」步骤逐层查 |
| 首次调用慢（秒级） | checkpoint 冷加载 | 预热一发即稳态（32-300ms） |
