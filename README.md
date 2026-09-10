# 近邻托育 Linux 部署版

这是使用真实账号、服务端数据库和文件存储的完整网页应用，不需要 Docker。将本目录的内容上传到 GitHub 仓库根目录，再在 Linux 服务器拉取运行。不要只上传 `public`，也不要使用旧版 `jinlin/dist` 静态文件部署。

## 已实现的功能

| 家长端 | 机构和老师端 |
| --- | --- |
| 注册、登录、修改密码、退出登录 | 命令行初始化管理员，后台创建及停用老师 |
| 宝宝档案、预约草稿 | 开放预约日期、时段和名额 |
| 查看实时剩余名额、提交及取消预约 | 分配老师、确认、拒绝、完成预约 |
| 阅读三份协议、手写签名、历史文件查看 | 发布正式协议新版本，保留历史已签版本 |
| 查看自己的照片、视频、饮食、午睡和情绪记录 | 为负责的预约上传媒体并发布成长记录 |
| 7 篇育儿知识、6 项工具资源、服务端收藏 | 老师在家长交流区真实回复 |
| 留言、话题标签、评论、点赞、我的留言 | 管理员隐藏不适宜的交流内容 |

所有账号、预约、签名、档案、评论、点赞、收藏和照护记录都写入服务器。浏览器不保存这些业务数据。没有预置家长、老师、虚构预约或自动生成的成长记录。

## 运行环境和目录

- Linux 单机，使用 systemd 和 Nginx；下面以 Ubuntu 22.04/24.04 或 Debian 12 为例。
- Node.js 24 LTS，24.14 或更新的 24.x。使用内置 SQLite，暂无第三方 npm 运行依赖。
- 建议至少 2GB 内存，磁盘按视频规模准备，建议预留 20GB 以上。
- 程序固定放在 `/opt/jinlin`；Node 放在 `/opt/node24`；数据放在 `/var/lib/jinlin`，与代码目录分离。
- 一台服务器、一个 Node 进程。数据库位于本机磁盘，不放在网络共享盘上；不使用 PM2 cluster 或多机共享 SQLite。

```text
public/                 网页、知识内容及工具资料
server/                 HTTP API、权限、数据库和签名校验
scripts/account.mjs     创建账号或重置密码
scripts/backup.mjs      一致性数据库备份及媒体备份
deploy/                 Linux、Nginx、systemd 配置
test/                   自动化后端测试
```

## 1 安装运行环境并拉取代码

先把源码上传到自己的 GitHub 仓库。以下 `你的仓库地址` 改为实际 HTTPS 或 SSH 仓库地址；私有仓库由你的 SSH 密钥或 Git 凭据访问，不把凭据写入代码。

```bash
sudo apt-get update
sudo apt-get install -y git nginx curl ca-certificates xz-utils certbot
sudo git clone 你的仓库地址 /opt/jinlin
cd /opt/jinlin
sudo bash deploy/install-node24.sh
export PATH=/opt/node24/bin:$PATH
node -v
sudo env PATH=/opt/node24/bin:$PATH /opt/node24/bin/npm ci --ignore-scripts
npm test
```

`install-node24.sh` 从 Node.js 官方分发地址读取最新 24.x Linux x64/arm64 包，并按官方 SHA-256 清单验证。已有满足要求的 Node.js 时，也可以直接调整两个 `.service` 中的 `ExecStart` 路径使用现有安装，不必运行安装脚本。

## 2 创建服务用户和数据目录

```bash
sudo useradd --system --home /var/lib/jinlin --shell /usr/sbin/nologin jinlin
sudo install -d -o jinlin -g jinlin -m 700 /var/lib/jinlin
sudo install -d -o jinlin -g jinlin -m 700 /var/backups/jinlin
sudo chown -R root:jinlin /opt/jinlin
sudo chmod -R g+rX /opt/jinlin
sudo install -o root -g jinlin -m 640 deploy/jinlin.env.example /etc/jinlin.env
sudo nano /etc/jinlin.env
```

若服务用户已存在，跳过 `useradd`。生产配置示例：

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://care.your-domain.com
DATA_DIR=/var/lib/jinlin
TRUST_PROXY=1
TZ=Asia/Shanghai
```

把域名换成你的真实域名；`PUBLIC_ORIGIN` 不带尾部 `/`，也不包含网页路径。它必须与家长访问的地址完全一致，服务端用它校验请求来源。端口 3000 仅监听回环地址，由 Nginx 转发，不直接开放到公网。

## 3 初始化管理员并启动

```bash
cd /opt/jinlin
sudo -u jinlin env DATA_DIR=/var/lib/jinlin /opt/node24/bin/node scripts/account.mjs --username admin --name 机构负责人 --role admin
```

命令会提示输入至少 12 位的密码，输入不回显。没有默认账号或默认密码，也不会从环境变量反复覆盖管理员密码。

```bash
sudo install -m 644 deploy/jinlin.service /etc/systemd/system/jinlin.service
sudo systemctl daemon-reload
sudo systemctl enable --now jinlin
sudo systemctl status jinlin --no-pager
curl http://127.0.0.1:3000/api/health
```

健康检查应返回 `{"ok":true}`。日志：`sudo journalctl -u jinlin -n 100 --no-pager`。

## 4 配置域名和 HTTPS

域名 A/AAAA 记录指向服务器。放行 TCP 80、443，并保留你当前使用的 SSH 端口。以下文件中的 `care.example.com` 都替换成同一个实际域名。

先使用只用于证书申请的 HTTP 配置：

```bash
sudo install -d -m 755 /var/www/certbot
sudo cp /opt/jinlin/deploy/nginx-http.conf /etc/nginx/sites-available/jinlin
sudo nano /etc/nginx/sites-available/jinlin
sudo ln -s /etc/nginx/sites-available/jinlin /etc/nginx/sites-enabled/jinlin
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d care.your-domain.com
```

如果链接已存在，无需重复执行 `ln -s`。证书签发后启用正式配置：

```bash
sudo cp /opt/jinlin/deploy/nginx.conf /etc/nginx/sites-available/jinlin
sudo nano /etc/nginx/sites-available/jinlin
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

正式配置的域名、证书路径和 `/etc/jinlin.env` 中的地址必须一致。若同域名已有 Nginx 站点，需要将配置合并到那个站点，不能建立冲突的 `server_name`。

证书自动续期后需要让 Nginx 重载证书：

```bash
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh > /dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

浏览器打开你的 HTTPS 域名，使用刚创建的管理员账号登录。整个站点由 Node 提供，不要给 `/var/lib/jinlin` 或 `uploads` 配置静态目录映射；媒体必须经过服务端权限检查。

## 5 开放真实业务

按下面顺序在管理员工作台设置：

1. 在“正式协议”填写机构名称、联系及隐私事务方式，并发布机构审核通过的三份正式文件。首次发布前不开放家长注册和预约。
2. 在“老师账号”创建老师，通过安全方式交付初始密码。老师可登录后修改密码。
3. 在“时段与名额”开放真实可服务的日期、起止时间和容量。禁止同一天的重叠时段，已创建时段的日期和时间不可改写。
4. 家长注册账号、填写宝宝档案、选时段、签名并提交预约。待确认预约也占用容量；取消或拒绝会释放名额。
5. 管理员分配老师并确认预约；老师仅看到分配给自己的预约和对应宝宝信息。
6. 服务发生后，老师为该预约上传照片或视频，填写记录时间、饮食、午睡和情绪后发布；对应家长即可查看。记录时间须在服务时段内且不能晚于当前时间。

家长登录使用账号和密码，不依赖短信或微信接口。手写签名、协议正文版本、健康资料快照、时间和校验摘要会真实保存；当前未接入实名认证、第三方 CA 电子签章或可信时间戳服务。

主页的托育主题图片是原有的 AI 生成配图，不会作为真实宝宝照护记录。真实成长区初始为空，只显示老师上传的内容。文章和工具资料为随源码发布的内容，可在 `public/content.js` 及 `public/assets` 中维护，更新后重新部署。

## 6 日常更新

数据目录在代码目录外，更新源码不会覆盖家长资料。首次拉取仓库时可通过下面命令记录代码版本：`sudo git -C /opt/jinlin rev-parse HEAD`。

每次更新先备份，然后拉取、测试、重启：

```bash
cd /opt/jinlin
sudo -u jinlin env DATA_DIR=/var/lib/jinlin /opt/node24/bin/node scripts/backup.mjs /var/backups/jinlin
sudo git pull --ff-only
export PATH=/opt/node24/bin:$PATH
sudo env PATH=/opt/node24/bin:$PATH /opt/node24/bin/npm ci --ignore-scripts
npm test
sudo systemctl restart jinlin
curl http://127.0.0.1:3000/api/health
```

`npm ci` 和 `npm test` 使用对代码目录有写权限的部署账号执行；如果源码由 root 拉取，则用 `sudo env PATH=/opt/node24/bin:$PATH /opt/node24/bin/npm ci --ignore-scripts`，测试不需要写业务数据目录。

修改环境配置后重启服务；修改 Nginx 配置后先 `nginx -t` 再 reload。数据库迁移随服务启动执行；程序会拒绝打开比自身支持版本更新的数据库。回滚包含数据库结构变化的发布时，应同时使用兼容的数据库备份，不能只退代码。

## 7 备份和恢复

手工备份命令见上一节。备份使用 SQLite 在线备份 API，包含已提交的 WAL 数据，并复制数据库快照引用的媒体文件；不会把正在上传的半成品当成有效媒体。成功后写入 `backup.json`。

启用每天凌晨自动备份：

```bash
sudo install -m 644 deploy/jinlin-backup.service /etc/systemd/system/
sudo install -m 644 deploy/jinlin-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jinlin-backup.timer
sudo systemctl list-timers jinlin-backup.timer
```

备份按时间保存，不自动删除旧备份。按你的保留周期清理并定期复制到另一台服务器或受控备份位置，检查数据库、上传目录和备份目录的磁盘空间。

恢复时选定一个包含 `backup.json`、`jinlin.sqlite` 和 `uploads` 的完整备份目录，停止应用，保留原数据目录，再复制完整快照：

```bash
sudo systemctl stop jinlin
sudo mv /var/lib/jinlin /var/lib/jinlin-before-restore-$(date +%Y%m%d-%H%M%S)
sudo cp -a /var/backups/jinlin/选定的备份时间目录 /var/lib/jinlin
sudo chown -R jinlin:jinlin /var/lib/jinlin
sudo chmod 700 /var/lib/jinlin
sudo systemctl start jinlin
curl http://127.0.0.1:3000/api/health
```

不要仅覆盖运行中的 SQLite 主文件，也不要把旧目录里的 `-wal`、`-shm` 文件混入恢复后的目录。

## 8 账号恢复与排错

家长忘记密码后，由机构核验身份，再通过服务器重置账号密码：

```bash
cd /opt/jinlin
sudo -u jinlin env DATA_DIR=/var/lib/jinlin /opt/node24/bin/node scripts/account.mjs --username 待恢复账号 --reset
```

这会保留原账号角色、更新密码并撤销其所有旧会话。不要把密码作为命令行参数。

| 现象 | 检查位置 |
| --- | --- |
| Nginx 返回 502 | `systemctl status jinlin`、端口 3000、Node 路径 |
| 请求来源不匹配 | `PUBLIC_ORIGIN` 与访问域名、HTTPS 协议是否完全一致 |
| 登录后仍要求登录 | 是否使用 HTTPS，Nginx 是否保留 Cookie，是否会话已过期 |
| 无法预约 | 正式协议是否发布、时段是否开放、有无剩余名额、开始时间是否已过 |
| 老师看不到宝宝 | 账号是否启用、预约是否已分配给当前老师 |
| 不能上传 / 视频不播放 | 图片 10MB、视频 50MB；Nginx 51MB；浏览器可播放的 MP4/WebM 编码；目录写权限 |
| 上传后未显示成长记录 | 上传只保存文件，需成功点击“发布成长记录”后才向家长开放 |
| 429 | 登录或操作频率限制触发，等待后再试 |

## 本地开发与验证

```bash
cp .env.example .env
npm run admin -- --username admin --name 管理员 --role admin
npm start
```

浏览器打开 `http://localhost:3000`。本地 `NODE_ENV=development` 允许 HTTP；生产环境强制 HTTPS 安全 Cookie。

已验证多账号权限、预约并发容量、重复提交、空白签名阻止、协议版本、私有媒体、评论身份、收藏、密码与停用会话、服务器重启持久化。网页端已走通注册到老师上传再到家长查看的流程，并检查 1440、1366、390 像素布局。systemd/Nginx 配置需在你的实际 Linux 主机上按上述步骤检查；当前交付不表示已连接或部署到你的服务器。

实现参考：[Node.js SQLite](https://nodejs.org/api/sqlite.html)、[Node.js Crypto](https://nodejs.org/api/crypto.html)、[Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[PNG 规范](https://www.w3.org/TR/png-3/)。


## 文档素材整合（2026-09-10）

- 管理员进入“正式协议”，点击“载入文档中的两份候选协议”。该操作只填写编辑框，不发布、不覆盖第三份登记表。核对公益入户服务适用范围、拍摄限制与测评采集范围，补全机构联系方式及第三份登记表，再勾选审核并发布。
- `{{organization}}`、`{{baby}}`、`{{age}}`、`{{parent}}`、`{{phone}}`、`{{date}}` 自动带入机构或预约信息。教师在家长签署后分配，因此 `{{teacher}}` 固定表示签署时待分配；已签文件另列当前真实老师安排，不改写历史签署文字。
- 本次数据库升级到版本 2，为新预约保存填好内容的协议快照。启动自动迁移；旧预约沿用原来保存的协议版本和档案，不追填新协议。更新前按备份章节备份，迁移后不能只回滚到旧代码。
- “托育服务 → 了解普惠托育”为页内阅读。“资源库 → 亲子互动训练卡”包含小熊、小袋鼠活动章节；“家庭亲子游戏卡”包含翻过小山坡章节。管理员可打开完整原稿及核对事项，家长端不提供尚未核实的具体训练要求。7 篇文章、6 项资源保持原数量。
- 活动原稿保留于 `server/materials.json`，不通过公共静态目录提供。管理员接口 `GET /api/admin/materials` 返回候选协议及原稿；政策发布在采用入户候选文本时要求 `reviewAcknowledged: true`。没有新增监控、晨检或晨检签字功能。

### 私有活动资料包怎么用

私有资料包单独交付，不在此公开仓库中。文档实际包含一张活动照片、两张姓名签字图和一张日期图。资料包只把活动照片与观察文字放入 `活动资料.private.json`；其他三张原件单独留存，不能用于自动签署新预约。

1. 用管理员或负责老师账号进入“发布成长记录”。须已有真实的已确认或已完成预约。
2. 在“导入私有活动资料包”选择 JSON 文件。此时仅在当前浏览器内存预览，没有上传。
3. 选择对应家长和宝宝的真实预约，填写服务时段内的真实活动时间，核对照片和观察内容。系统不会从原签字日期图推断记录时间，也不会创建过去的虚构预约；没有对应真实预约时，先保留资料包，不要关联到其他宝宝。
4. 点击“发布成长记录”，通过现有受保护的上传接口保存；对应家长可查看，其他家长和未登录用户不可读取。
5. 页面离开或退出登录会清理未发布图片的内存预览。发布失败时查看错误后重试；已出现成功提示的记录不要再次导入。

请保管好私有资料包，不要把它、原 Word、原始签名或照片复制到仓库、`public` 或 Nginx 网站目录。`.gitignore` 已排除 `*.private.json` 与 `*.docx`。

活动核对参考：[CDC 9 月龄陪伴建议](https://www.cdc.gov/act-early/milestones/9-months.html)、[AAP 婴儿活动建议](https://www.healthychildren.org/English/ages-stages/baby/Pages/how-active-is-your-baby.aspx)。核对仅支持一般自主探索和陪伴建议，不等同于逐项认可原稿的训练时长、辅助动作或医学断言。
