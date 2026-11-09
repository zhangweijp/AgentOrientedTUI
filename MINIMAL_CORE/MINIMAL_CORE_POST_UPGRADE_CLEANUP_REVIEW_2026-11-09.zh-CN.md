# 升级后旧代码清理：MC Owner 独立验收

2026-11-09。结论：**APPROVED**。限定执行 Agent 提交的19路径完整差异；没有待修订问题。本次为整项交付后的唯一负责人代码复核，执行者未自批。当前结论批准采用，实际根目录采用另记。

批准 patch：`review-evidence/minimal-core-post-upgrade-cleanup-20261109/cleanup.patch`，SHA-256 `ee512a0b8df6a13ac71d89e6bfa7996e4f2c37088ec42362f6047eda3b78e93c`。候选：`.tmp/minimal-core-post-upgrade-cleanup-20261109/candidate`。报告 SHA-256：`82a94901b8ed17a7ac787ca71c74daec1e920881837525b8558fd5b8fc26b142`。

## 删除与保留的职责

共删除7文件；11个生产路径净减1769行，测试净减126行，配置／锁文件净减281行，文档净变0。没有用历史证据或临时目录清理充当代码减法。

| 实际差异 | 保留行为与复核依据 |
|---|---|
| Runtime `view-owned-tools.ts` 删除注册记录的冗余 `inputSchema` 引用和无人读取的 `canonical` 字符串 | 两处读取改用同一个冻结 `definition.inputSchema`；注册编译、最终身份核对、activation/token、容量计费及 cleanup 未删。原声明序列化仍用于 declarationBytes。 |
| IDE 删除全局文件／LowDB／LSP 服务及其专属导出、类型、Bus、状态与配置缓存 | 当前默认 factory → ScopedIDEApp → IDESession 链未改；文件操作、搜索、历史、LSP 分别由现有受管对象承担。仓内消费者与动态导入核对显示旧链的消费者随本次一起退出。 |
| LSP 客户端删除旧全局通知后备，标准库替代两行包装；服务端删除旧 registry 的 root/global 元数据及转发函数 | 当前 ScopedLSP 仍拥有 root 校验、配置、在途调用与关闭；客户端的诊断回调、map、版本和等待者保留，直接 spawn 的参数与资源身份不变。 |
| IDE 删除 emittery、lowdb、zod、vscode-langservers-extracted 四个专属依赖及对应锁项 | 当前 Native LSP、JSON-RPC、诊断类型、glob、JS API6 开发工具与精确补丁保留；正常安装包通过实际运行。 |
| 迁移3项文件创建测试、删除旧归一化／旧 singleton 专属测试；删除 Host 失效 server:v2 脚本 | 当前创建入口仍验证父目录创建、不覆盖正文、8个竞争创建只有1个成功、已有空文件不截断。Host 脚本目标文件不存在，实际启动链无改动。 |

保留文本替换算法和显式旧数据导入。旧 IDE 深层服务入口退出已写入当前说明；SDK／Runtime 的当前公开入口保持。作者与维护者不再需要在全局服务和每 App 会话之间选择或同步状态，没有新抽象或职责转移。

## 实际独立核对与验证

- 审查完整变更、实际保留源码、当前消费者和测试迁移。逐项核对19份 before／after、候选及共享根；按既有936项基线确认候选变动只有声明的19项，共享输入未漂移。
- 在临时目录独立应用 patch，19项结果全部匹配，whitespace 检查通过。核对三份 tar 与实际安装的555件文件完全一致，候选文件匹配，IDE旧服务产物退出、原生程序执行位保留。
- 独立比较 Runtime 114份、SDK 17份完整声明，逐字节相同；IDE默认入口声明不变，5份旧链声明退出，辅助声明的删改与实现对应。
- 独立执行当前 ViewType Tool 10项及迁移后的文件创建3项，全部通过。
- 对已正常安装的实际三包独立运行 IDE 的5组真实 Worker场景，共44次调用，全部通过。覆盖双App、文件操作、七类TypeScript查询、旧身份拒绝、关闭和Worker复用／恢复；3次cleanup均 resourcesReleased=true，交互Scope／字节及存储在途IO归零。

执行方默认完整 Runtime 2092项、SDK187项、IDE63项和35个集成场景，以及原生LSP5项、ScopedLSP5项、容量2项、严格类型／正常包消费已读取真实命令、退出码及原始结果，直接复用，不重复矩阵。默认完整回归仅以实际控制台日志为证，没有把未生成的JSON reporter文件当作证据。

首轮漏迁调用、测试父目录竞争、沙箱监听、安装／编译器平台包问题均有原失败及最终通过结果；只执行helper而未运行场景的记录已明确排除。负责人实际运行使用合成临时数据，未启动用户Host或真实模型。

负责人事实与原始结果见 [review-facts.json](../review-evidence/minimal-core-post-upgrade-cleanup-owner-20261109/review-facts.json)、[身份与patch核对](../review-evidence/minimal-core-post-upgrade-cleanup-owner-20261109/identity-and-patch.json)、[实际IDE调用](../review-evidence/minimal-core-post-upgrade-cleanup-owner-20261109/installed-ide-facts.json)。

## 边界与下一步

原生LSP验证仍限darwin-arm64；其他OS、非TypeScript服务、用户GUI及真实模型未扩大验证。当前临时补丁、历史导入、Scope与Ref合同、消息恢复均继续保留。没有对整份SRT清单、全面Legacy退出或正式发布作完成声明。

下一步是本19路径的选择性采用，不再开一轮清理审查。SRT Owner按既定分工协调采用，与Clean正在实现的元数据／结果／协议任务对齐实际文件；本清理未改其Core/SPI/Worker/SDK／工厂文件。采用通过后更新当前状态，不需要新增人工验收。

采用准出：核对当前目标仍匹配before；备份原件，采用after并删除7个退休文件；IDE冻结安装及受影响Runtime／IDE构建通过，旧产物退出。SDK声明／源码未改、Host只有脚本删除，不追加无变化的行为矩阵。

采用执行Prompt：从本报告批准的精确19路径开始，逐项核对当前before并保留原件，再选择性应用cleanup.patch；不覆盖其他开发线文件。完成IDE冻结安装、Runtime／IDE构建与after／旧产物检查，真实冲突只处理对应文件。保留本次已通过的完整测试和包消费结果，不做第二轮代码审查，不提交或发布。采用完主动回传结果，负责人不轮询聊天。
