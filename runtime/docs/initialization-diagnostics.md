# INIT / OPEN 的本地安装诊断

模块加载/初始化失败对应 `INIT / E_INIT_FAILED`；首次组件提交失败对应 `OPEN / E_OPEN_FAILED`。AppManager 的本地安装 Promise 拒绝值保留以下 cause 链：

```text
INSTALL_FAILED (AppManager)
  cause → INSTALL_FAILED (WorkerSandbox)
    cause → E_INIT_FAILED 或 E_OPEN_FAILED (AppWorkerHost，含 appId / phase)
      cause → { phase, name, message, stack?, truncated? }
```

Worker 在清理前捕获原始错误，只发送这个平坦的普通数据记录，不传输原生 Error 或任意 App payload。普通异常的 name/message/stack 原样保留；诊断字段上限分别为 128 / 2048 / 8192 个 JavaScript 字符，裁剪时明确标记 `truncated: true`。Native Error.stack 可以是惰性 accessor，读取失败不会覆盖主异常；缺失/不可读字段使用通用值或省略 stack。Host 复用已有有界 JSON 捕获（64 KiB，深度 2、16 节点），校验字段和请求 phase；appId / phase 由本地绑定请求确定。

诊断只供宿主开发排查：各层 Error.cause 都是非枚举属性，不会随默认 JSON 序列化进入公开 ToolResult；不将原始堆栈、路径或消息自动加入 View、关闭摘要。开发者可主动检查本地 cause。ToolResult 的业务错误、effects/unknown 和重试合同没有改变。

OPEN 失败时仍携带真实 persistence / appCleanup 收尾报告，不能让 `PERSISTENCE_CLOSE_FAILED` 替代首次渲染的原始错误。资源已释放与业务/持久化成功分别报告；`resourcesReleased: true` 不把失败安装或中止保存改成成功。INIT 失败仍终止不可信 Worker，失败实例不会作为健康实例继续运行。
