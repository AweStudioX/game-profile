# Game Profile

[English](README.md) · **简体中文**

一个面向个人的私有游戏看板。无需修改代码，不依赖数据库或后台任务，即可在 Vercel 部署。你可以先体验虚构数据，也可以接入自己的 Steam 账号。

## 快速开始

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile&project-name=game-profile&repository-name=game-profile)

1. 点击 **Deploy with Vercel**，或 fork 后[导入自己的仓库](https://vercel.com/new)。使用仓库根目录，保留 `vercel.json` 的默认配置。
2. 不填环境变量即可体验虚构数据。要查看自己的记录，见[连接 Steam](#连接-steam)。

## 功能

- 浏览和搜索游戏库，查看游玩时长、最近活动及成就。
- 同款游戏的多平台记录匹配后只显示一张卡片，成就进度仍按平台独立统计。
- 真实数据仅支持 **Steam**。PlayStation 和 Nintendo Switch 只出现在演示数据中，不提供在线同步。

## 连接 Steam

在 Vercel 部署表单或 **Project → Settings → Environment Variables** 中填齐下列三项。除非也想在预览环境使用真实数据，否则只配置到 **Production**。

| 配置项 | 填写内容 |
| --- | --- |
| `STEAM_ID` | 17 位 SteamID64，可在 [Steam 账户明细](https://store.steampowered.com/account/)查看。 |
| `STEAM_WEB_API_KEY` | [自行申请的 Steam Web API Key](https://steamcommunity.com/dev/apikey)，保存为 **Secret**。 |
| `PROFILE_PASSWORD` | 随机生成的看板密码，16–120 位可打印 ASCII 字符，不含空格。保存为 **Secret**，不要复用 Steam 密码。 |

新增或修改变量后，重新部署。打开看板，点击 **登录查看**，用 `owner` 和 `PROFILE_PASSWORD` 登录。无需在看板里输入 Steam 凭证。

## 本地开发

需要 Node.js 24。

```sh
git clone https://github.com/AweStudioX/game-profile.git
cd game-profile
npm run dev
```

打开 <http://127.0.0.1:3000>。若要在本地连接 Steam，将 [`.env.example`](.env.example) 复制为 `.env.local`，填齐三项后重启服务。修改后可用 `npm test` 验证。

## 常见问题

| 现象 | 排查方法 |
| --- | --- |
| 页面仍显示演示数据 | 检查变量是否配置到了当前环境，并重新部署。 |
| 页面提示配置未完成 | 检查三项变量是否都已填写且格式正确。 |
| 读不到 Steam 数据 | 检查 Key、SteamID64，以及 Steam 隐私设置中的「游戏详情」是否允许 API 读取。 |

## 隐私

- 真实档案的数据接口需要登录。页面框架和配置指南公开；浏览器和 CDN 不缓存个人数据响应。
- 游戏库和活动快照在单个运行中的函数实例内分别最多缓存 5 分钟和 1 分钟；没有数据库或定时同步。封面等素材直接从 Steam CDN 加载。
- 部署者负责自己的配置、数据处理区域，以及遵守 [Steam Web API 条款](https://steamcommunity.com/dev/apiterms)。本项目与 Valve 无隶属关系。

## 贡献

欢迎提交 Issue 和 Pull Request。反馈问题时请附复现步骤；提交修改前运行 `npm test`，并保持两份 README 同步。截图和测试数据请使用虚构记录，不要提交凭证或个人快照。

## 许可证

[MIT](LICENSE)。Steam 客户端、数据规范化与聚合模块源自 [AniketRaj314/gaming-stats-api](https://github.com/AniketRaj314/gaming-stats-api)，保留原版权和许可声明。
