# SQLite 工作项 App

普通 TypeScript App 使用 `@aotui/sdk/app`。`aoapp.json` 由 Host 发现，Runtime 为 App 实例启动 Worker。SQLite 保存标题、正文、状态与修订号。App 实例只保存当前选中项。

## 本地运行

需要 Node.js、仓库配套的 Runtime 和 SDK，以及支持 `-json`、`changes()` 和 `total_changes()` 的 `sqlite3`。实际验证使用 macOS、Node.js `24.15.0` 和 SQLite `3.51.0`。从仓库根目录执行，Runtime 和 SDK 使用各自已安装的依赖。

```sh
pnpm --dir runtime build
pnpm --dir sdk build
pnpm --dir demo-apps/sqlite-work-items install
pnpm --dir demo-apps/sqlite-work-items build

demo_db_dir=$(mktemp -d)
sqlite3 "$demo_db_dir/work-items.sqlite" < demo-apps/sqlite-work-items/work-items.sql
node demo-apps/sqlite-work-items/demo.mjs "$demo_db_dir/work-items.sqlite"
sqlite3 -json "$demo_db_dir/work-items.sqlite" 'SELECT title, status, revision FROM work_items ORDER BY id;'
```

`demo.mjs` 通过公开 `AppRegistry`、`getAppInteraction` 和观察采用来调用 `open_item`、`set_status`，然后输出 View 与收据。第一项应显示 `done` 和 `revision 1`。脚本会关闭 Runtime。上面创建的示例数据库保留在 `demo_db_dir`，供独立查询。

已有仓库依赖的离线环境可以复用根目录链接的 Runtime 和 SDK，并用下面的命令替代示例 App 的 `install` 和 `build`。

```sh
demo_app=demo-apps/sqlite-work-items
mkdir -p "$demo_app/node_modules/@types"
[ -e "$demo_app/node_modules/typebox" ] || ln -s ../../../sdk/node_modules/typebox "$demo_app/node_modules/typebox"
[ -e "$demo_app/node_modules/@types/node" ] || ln -s ../../../../runtime/node_modules/@types/node "$demo_app/node_modules/@types/node"
PATH="$PWD/runtime/node_modules/.bin:$PATH" pnpm --dir "$demo_app" build
```

## 调用与恢复

- 列表中的 `[Review SDK guide](WorkItem:items[0])` 位于 `items` View。`open_item` 的 `item` 参数传 `items.items[0]`。打开后用 `detail.current` 调用 `set_status`。`close_item` 关闭详情并撤下更新 Tool。
- App 校验 Ref 属于当前选中项，用安全整数和状态枚举执行一次 `WHERE id = … AND revision = …` 条件更新。在同一个新 SQLite 连接中，`changes()` 统计直接改动，`total_changes()` 统计包括触发器在内的连接行改动。命令成功退出且计数有效时，直接改动一行确认写入，两个计数都为零返回 `VERSION_CONFLICT`，只有总计数非零则返回 `SQLITE_WRITE_PARTIAL` 和 `effects: 'partial'`。
- 已确认写入随后刷新失败时，收据为 `written: true, refreshed: false`。已启动的写命令无法确认结果时，收据表达 `unknown`。刷新失败、部分写入或效果未知时，诊断 View 撤下旧正文、Ref 和更新 Tool，保留刷新入口。`refresh` 只执行 `SELECT`，用原请求读取收据只读记录。

**业务数据合同。** `id` 在一个工作项的生命周期内固定，删除后也不得分配给新工作项。外部写入方每次修改工作项都须递增 `revision`。App 依靠这两条约束识别旧 Ref 和外部改动。

Host 将可信的绝对 `databasePath` 传入启动配置，可用 `sqliteExecutable` 指定绝对可执行文件路径，默认从 `PATH` 查找 `sqlite3`。App 直接以 argv 启动 CLI。读连接使用 `mode=ro`，写连接使用 `mode=rw`。列表最多 100 项，stdout 和 stderr 各限 64 KiB。过限会产生可恢复的诊断。App 的 `stop` 请求取消在途命令，`close` 等到直接子进程的 `close`。强制结束 Worker 时，Runtime 报告它已确认的资源与缺失的 App cleanup 证据。

## 回归

```sh
pnpm --dir demo-apps/sqlite-work-items test
```

测试使用临时数据库、真实 Worker 和独立 SQLite 查询。用例覆盖版本冲突、触发器跳过目标更新时的部分效果、写入后 stdout 超限、stderr 超限且副作用未知、启动失败、实际取消和强制关闭。POSIX 测试夹具通过一个临时脚本 `exec` 真实 `sqlite3`，用独立的 SQLite 事务持有读锁所需的排他锁，并记录进程与命令类别。设置 `AOTUI_TEST_SQLITE` 可以指定测试用的 SQLite 可执行文件。
