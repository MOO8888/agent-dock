# 发布到 GitHub

## 已打包源码

```powershell
npm run pack:source
```

输出位于 release/，包含一个源码目录、对应 ZIP 和逐文件 SHA-256 清单。不复制 .git/，不会携带本地 Git 历史、远程地址或账户信息。重复打包使用新的目录名，不覆盖旧包。

解压 ZIP 后，把里面源码目录的内容上传到你新建的空 GitHub 仓库。不要把 ZIP 当成仓库源码文件上传；ZIP 适合另放到 Releases 下载。

## Git 命令方式

在干净源码目录中执行：

```powershell
git init -b main
git add .
git status --short
git commit -m "Initial AgentDock prototype"
```

提交时如提示没有作者身份，请设置自己的 Git 用户名和邮箱。然后在 GitHub 创建空仓库，复制它提供的远程地址：

```powershell
git remote add origin <你的仓库地址>
git push -u origin main
```

尖括号部分替换为自己的地址。源码准备脚本不会自动创建仓库、配置 Git 身份或推送。

## 发布范围

源码包只选择代码、界面资源、自动检查、构建/启动脚本和公开文档。历史运行数据、登录目录、截图、生成成果、日志、编译二进制、依赖和私人记录不在包内。旧开发记录仍可在开发机器的 artifacts/ 中保留。

README 已明确实验状态及尚未完成的客户端兼容项。发布时建议沿用这一说明，不将原型描述为全部客户端开箱即用。
