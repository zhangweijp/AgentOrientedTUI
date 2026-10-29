# Stage 8 R1 范围

只修已 fulfilled transport 对应的旧生命周期 continuation。

- runtime/src/engine/app/worker-host.ts：捕获并复核当前 Worker；检验同 Worker error 与新 INIT 无法仅靠 object identity/terminal 状态区分后，才增加一个内部失效序号，覆盖 terminate/error/exit/INIT 的旧请求。保留 close/release/I/O/监听器/RESET 逻辑。
- runtime/src/engine/app/worker-host.r1-terminal-race.test.ts：新建回归；实际 sendRequest/handleMessage 链路，不 mock sendRequest；原意保留外部 listener 在 Host resolve transport 后同步 terminate。覆盖 start/open/pause/resume/reinitialize、error/exit、新 INIT/Worker、合法关闭重开。
- 本 R1 子目录：只读基线、原始红绿日志、六项全量命令、三轮定向复跑、独立增量 patch 与指纹。

不改任何既有测试、独立复现脚本、上轮验收文件、Core/SDK/IDE 生产行为、默认路由、实验默认值或 Strict 标志。不启动代理，不执行 Wave 2，不宣布 Stage 8 PASS。
