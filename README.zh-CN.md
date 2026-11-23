# Game Profile

[English](README.md) · **简体中文**

一个面向个人的公开游戏展示看板，支持 Steam、PlayStation 和 Nintendo Switch，管理操作需要密码登录。部署到 Vercel 后直接在站内绑定账号，不用改代码。

## 快速开始

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile&project-name=game-profile&repository-name=game-profile&env=PROFILE_PASSWORD,PROFILE_ENCRYPTION_KEY&envDescription=%E8%AF%B7%E5%A1%AB%E5%86%99%E7%9C%8B%E6%9D%BF%E5%AF%86%E7%A0%81%E5%92%8C%E7%8B%AC%E7%AB%8B%E7%9A%84%E5%8A%A0%E5%AF%86%E5%AF%86%E9%92%A5%E3%80%82&envLink=https%3A%2F%2Fgithub.com%2FAweStudioX%2Fgame-profile%2Fblob%2Fmain%2FREADME.zh-CN.md%23%E9%83%A8%E7%BD%B2%E6%B8%85%E5%8D%95&products=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

Vercel Hobby 用户请选择**个人 GitHub 账号**，不要选组织。在部署向导中创建 Neon 数据库，再填下面两个密钥。集成会自动提供 `DATABASE_URL`。

## 功能

- 浏览和搜索以封面为主的游戏库。首页保留游玩中、未检测到游玩和状态未知的展示，以及活动来源与观测时间、各平台同步状态、同步时间和游戏数量。
- 默认「经典」跟随系统明暗，采用 [Dissolve](https://dissolve.rselmi.com/) 风格的平台分段筛选、滚动数字和带按压反馈的「显示更多」按钮。开启「减少动态效果」时不播放动效。顶栏仍可切换像素和霓虹都市，偏好按浏览器保存。
- 同款游戏的多平台记录匹配后只显示一张卡片，成就进度仍按平台独立统计。
- Steam 成就和 PlayStation 奖杯分开显示；Nintendo 提供游玩记录。
- 未登录也能浏览面板。通过顶栏「登录」进入管理页，可按平台选择是否公开玩家昵称、ID 和可用头像；默认不公开身份信息。
- 游戏库默认每天自动同步一次（北京时间 10:00 开始），可在站内改成每小时一次。使用 [Vercel Schedules（Beta）](https://vercel.com/docs/schedules/limits)，无需开着网页。

## 部署清单

| 密钥 | 怎么生成 |
| --- | --- |
| `PROFILE_PASSWORD` | 用密码管理器生成独立密码。支持 12–120 位不含空格的可打印 ASCII 字符，推荐至少 16 位。看板用户名是 `owner`。 |
| `PROFILE_ENCRYPTION_KEY` | 运行 `openssl rand -hex 32`，或用密码管理器生成同等强度的随机值。重新部署时保留原值，换值后旧数据库不能解密。不要复用看板密码。 |

部署后点站内 **连接平台**，登录后按各平台指引操作。Steam 需要 [SteamID64](https://store.steampowered.com/account/) 和 [Web API Key](https://steamcommunity.com/dev/apikey)；PlayStation 复制 Sony 的 NPSSO；Nintendo 复制登录后的回调链接。不要把平台密码输入看板。

## 升级现有项目

1. 把模板更新同步到现有仓库。如果是通过模板生成的仓库，不是 GitHub fork，在现有仓库合入上游改动即可；不用重建 Vercel 项目。
2. 在现有 Vercel 项目的 **Storage** 创建并连接独立的 Neon 数据库，确认 Production 出现 `DATABASE_URL`。在 **Settings → Environment Variables** 添加 `PROFILE_ENCRYPTION_KEY`，保留原 `PROFILE_PASSWORD`。
3. 重新部署 Production，打开 `/connect.html`。原 `STEAM_ID` 和 `STEAM_WEB_API_KEY` 仍可用，之后站内保存的 Steam 配置优先。PlayStation 和 Nintendo 需要重新绑定，不会从其他部署搬运凭证。

## 本地开发

需要 Node.js 24。

```sh
git clone https://github.com/AweStudioX/game-profile.git
cd game-profile
npm ci
npm run dev
```

打开 <http://127.0.0.1:3000> 查看虚构演示数据。展示真实记录时，将 [`.env.example`](.env.example) 复制为 `.env.local`，填入独立的本地 PostgreSQL 和两个密钥。用 `npm test` 验证修改。

## 常见问题

| 现象 | 排查方法 |
| --- | --- |
| 页面仍显示演示数据 | 确认变量已配置到 Production，并重新部署。 |
| 连接页无法读取存储 | 检查 `DATABASE_URL` 和 `PROFILE_ENCRYPTION_KEY`。重装时使用原加密密钥，或另建数据库。 |
| 读不到 Steam 数据 | 检查 Key、SteamID64，以及 Steam 隐私设置中的「游戏详情」是否允许 API 读取。 |
| PlayStation 提示需要重连 | 正常刷新 token 时保留已同步游戏库；刷新中断或授权失效时仍需重新连接，单纯打开连接页不会重新授权。 |

## 隐私

- 真实游戏库、游玩动态和成就可公开查看；平台设置和修改操作需要登录。浏览器和 CDN 不缓存个人数据响应。
- 玩家身份按平台独立控制，默认关闭。关闭后服务端不返回该平台的昵称、ID 或头像。Steam 展示 SteamID64 和昵称，PlayStation 展示 Online ID，Nintendo 展示账号昵称，不使用内部 ID、邮箱或 Switch 好友码。头像随平台同步更新，缺失时使用平台图标。
- 平台凭证和同步快照加密写入 PostgreSQL。不同部署请使用独立数据库。封面和成就图标从各平台 CDN 加载。
- PlayStation 和 Nintendo 使用非官方接口，可能失效或需要重新授权。部署者负责遵守各平台条款，包括 [Steam Web API 条款](https://steamcommunity.com/dev/apiterms)。本项目与各平台无隶属关系。

## 贡献

欢迎提交 Issue 和 Pull Request。反馈问题时请附复现步骤；提交修改前运行 `npm test`，并保持两份 README 同步。截图和测试数据请使用虚构记录，不要提交凭证或个人快照。

## 许可证

[MIT](LICENSE)。Steam 客户端、数据规范化与聚合模块源自 [AniketRaj314/gaming-stats-api](https://github.com/AniketRaj314/gaming-stats-api)，保留原版权和许可声明。
