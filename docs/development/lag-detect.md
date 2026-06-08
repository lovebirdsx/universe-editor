# 开发加快的方案

pnpm dev和pnpm e2e会频繁读取文件，涉及到的目录：

* repo所在目录
* C:\Users\xx\AppData\Local\Temp

建议：

* 关闭windows search，Everything等需要频繁访问磁盘的服务
* 将repo和临时目录排除在Windows Defender之外
