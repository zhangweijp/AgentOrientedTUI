# Host 内 DeepSeek 人工联合验收：MC 范围建议

2026-11-09。供 SRT Owner 合并 Planning／Ref 场景使用。下面是按当前代码核对的人工操作建议，尚未实际运行，不改变已完成的工程验收，也不新增开发或准出门禁。

建议采用 **5 个 MC 场景＋2 个 Planning／Ref 场景**，合计约 **20～30 分钟**。MC 部分约 14～18 分钟。正常流程只在“人工修改文件”和“点击暂停／恢复”两处停下来；最终关闭放在联合验收末尾。不要将模型复述的预期结果当作已经通过。

## 当前入口与操作事实

开始前，由人创建一个新的空目录，在 Host 中选作本次项目，新建聊天，选择 DeepSeek，并在该聊天的 Apps 中启用 IDE／Planning。全程只使用这个目录和本次新建数据。App 未运行时，通过当前 Tools 中的 `system-open_app` 打开，`app_id` 取实际枚举值。

| 操作 | 当前支持方式及注意点 |
| --- | --- |
| 新建验收文件 | `create_file({filePath, content})`，绝对路径。文件不存在才会创建；成功后通常直接打开 FileDetail，所以不能假定“创建后仍没有文件页” |
| 打开或重新读磁盘 | `multi_open_file({filePaths})`。已经打开的文件也会重新加载，是外部修改后的恢复入口 |
| 修改两份同类型文件中的一份 | 同一组 FileDetail 工具，`edit_file({filePath, oldString, newString})` 或 `write_file({filePath, content})`。路径选择业务文件，不用 Ref，不虚构“每个文件一份工具” |
| 关闭文件页 | `multi_close_file({filePaths})`，或 `close_file_detail({view_id})`，后者的 id 取当前 View 外层。关闭一页后，只要另一 FileDetail 还在，共享工具应保留 |
| 刷新目录树 | `refresh_workspace({})`，不能用它代替重新加载文件正文 |
| 关闭 IDE App | `system-close_app({app_id})`。核对收据、App 状态及下一轮当前投影；不能仅因页面消失就声称全部底层资源释放 |
| 暂停／恢复 Agent | Host 的 `Pause Agent`／`Resume Agent` 按钮。暂停阻止后续轮次；已经开始的模型请求及该轮工具可以完成。它不是撤销已开始的操作，也不是 App 的暂停工具 |

IDE 的函数名由适配器按 App／ViewType／工具名生成。Prompt 中的上述短名用于识别操作，真正调用必须取当轮 Tools 中的完整名称和 Schema，不能凭短名猜函数名。Root 提示中的名称也不等于当前工具已激活。

Host 的 TUI 面板是应用预览，可能显示尚未为该聊天启用的 App。先确认聊天 Apps 已启用；工具是否可用以模型当轮实际 Tools 为准，不能仅凭预览面板判断。

## 可合并到最终 Prompt 的 MC 操作段

```text
现在进行 AOTUI 人工验收。请实际执行下面的操作，只操作本次新建的验收目录和数据。使用当前 Tools 的真实名称、参数和当前 View；文件使用绝对路径，不包装成 Ref。不要调用其他文件工具替代 IDE，也不要检查源码、运行测试框架或制作哈希清单。

先从当前 Workspace 确认本次新建空目录的绝对路径。若无法确定，集中问我一次；如果已经明确，不再重复确认。下面的 a.txt、b.txt 均指这个目录里的新文件。

每项记录实际操作、工具结果和随后看到的当前页面。Tool 主要返回操作收据，文件正文从 FileDetail 读取；聊天里的旧消息和旧工具收据可以保留，不把它们当作仍生效的当前页面。每次改变页面后使用下一轮得到的上下文，不在同一轮预先安排依赖新页面或新工具的调用。除两处人工操作外，连续执行，不逐项等我批准。

MC-1：工具随页面出现，约 3 分钟。
1. 在还没有 FileDetail 时，报告当轮 Tools 中有没有 IDE 的 write_file／edit_file；以实际 Tools 为准，不以 Root 文字为准。
2. 用 create_file 创建 a.txt，内容为一行 MC-A-v0；创建 b.txt，内容为一行 MC-B-v0。末尾均有换行。确认两个文件页显示对应内容。
3. 用 multi_close_file 关闭这两个测试文件页。下一轮确认没有 FileDetail，相关文件编辑工具不再可用。
4. 只打开 a.txt，确认 FileDetail 和文件编辑工具出现；再打开 b.txt，确认有两个 FileDetail，编辑工具仍是按类型共享的一组。记录实际完整工具名，不要求复制整份 Schema。

MC-2：选对文件、最新页面和关闭单页，约 4 分钟。
1. 只修改 b.txt：先把 MC-B-v0 改成 MC-B-v1，读取更新后的 FileDetail；再改成 MC-B-v2，再读取当前 FileDetail。每次工具调用分别等待结果和新上下文。
2. 当前 a.txt 仍应为 MC-A-v0，b.txt 应为 MC-B-v2。记录它们各自的路径、View id 和当前正文。当前投影不应同时存在自称当前状态的 b.txt v0／v1／v2 多份页面；历史聊天中的旧记录不计入。
3. 关闭 a.txt，保留 b.txt。下一轮确认 b.txt 的编辑工具仍在。
4. 用仍在的 write_file 尝试一次写入已关闭的 a.txt，内容为 MC-A-must-not-land。这是针对新建测试文件的预期拒绝步骤：应报告未加载文件的失败（当前常见 code 为 IDE_FILE_NOT_LOADED），不能偷偷重新打开或创建文件来替它成功。重新打开 a.txt，确认仍为 MC-A-v0，再关闭它。如果意外写入成功，记失败并保留该结果，不再写 a.txt。

MC-3：外部变化被识别，然后正常恢复，约 4 分钟。
1. 确认当前加载的 b.txt 是 MC-B-v2。现在停下来，告诉我它的准确绝对路径，请我用 Host 外的文本编辑器将内容改为一行 MC-B-external 并保存。我回复“已保存”后继续。
2. 收到回复后，先不要重新打开／刷新／用别的工具读取 b.txt。直接使用现有 write_file 尝试一次把它改为 MC-B-stale-must-not-land。应因外部变化而拒绝，当前预期 code 为 RESOURCE_CONFLICT。记录实际结果；不要自动重试或强制覆盖。
3. 若按预期拒绝，使用 multi_open_file 重新加载 b.txt，确认当前 FileDetail 是 MC-B-external，人工内容未被覆盖。然后基于新读取的内容，正常编辑为 MC-B-external-plus-agent，并确认当前页面更新。这证明“识别变化后重新读取再操作”的恢复流程。
4. 若旧写入意外成功或结果未知，先记下真实情况并停止该文件的后续写入；不要把后面的恢复写入当成冲突检查通过。

MC-4：人工暂停与续轮，约 2～3 分钟。
先告诉我：“下一条请发‘开始暂停测试’，在我工作时点击 Host 的 Pause Agent。”随后等待这条消息。
收到“开始暂停测试”后，仅重新打开并读取 b.txt，再用下一轮说明其当前内容，不写文件。我会在工作期间点击暂停。已经开始的一轮允许完成；验收重点是该轮结束后不会自行进入后续轮次。
我在暂停状态下发送：“继续验收：请回复 MC-RESUME-OK 和当前 b.txt 的正文，不修改文件。”待当前在途工作结束后，观察该新请求没有自动开始；再点击 Resume Agent。恢复后应处理这个请求，并按当前 View 报告内容。
暂停是否命中、恢复是否正常，由我补充人工观察。如果按钮一直不可点或没有赶上运行窗口，将这一项记为未测，继续最后关闭；不为了制造窗口反复调用工具或人为启动长任务。你不能凭自己的感觉宣称暂停期间没有底层模型调用。

MC-5：关闭文件页与 IDE 应用，约 2 分钟；放在联合验收末尾。
关闭本次仍打开的测试 FileDetail。下一轮确认相关页面退出，最后一页关闭后文件编辑工具不再可用。
再用实际 system-close_app 关闭 IDE；记录真实收据及下一轮 App 状态，确认它的运行页面和业务工具退出当前上下文。保留聊天供最终报告。遇到失败或 unknown 就如实记录，不能因页面消失改判成功。

最后与 Planning／Ref 结果合并成一张简短表：场景、通过／失败／未测、实际看到的证据、人工观察。记录第一次异常的工具名、参数和错误，以及实际恢复结果；不要只复述本 Prompt 的预期。单列 Host 对话未测的底层性质，不把缺少观察能力写成已通过。
```

## 解释范围与合并建议

值得纳入的都是用户能观察的行为：工具随页面变化、两个同类型页面选对业务文件、更新后只看见当前状态、关闭单页不误伤另一页、外部冲突明确拒绝及重新读取后可恢复、暂停后的续轮、App 正常关闭。这5项与Planning／Ref的两项合并即可，不额外叠加LSP资格、MCP异常注入或整套重启恢复矩阵。

需要注明“本次人工未测”的性质：每次调用究竟编译几次、单次通知／业务进入的内部计数、精确Observation／Ref旧绑定的撤销与内存引用释放、完整IPC来源防伪、所有process／lease／句柄归零、CPU／内存／耗时门槛，以及未实际接入的MCP／IM路径。正常工具调用、几行页面内容或模型声称“没问题”不能单独证明这些。关闭后参数被拒绝也不等于已经手动证明旧Observation失效；App关闭收据不等于看到了Runtime完整资源报告。

“最新页面”采用模型所见当前View与人工预览交叉观察即可；不要求用户找原始模型请求。没有原始输入时，结果只覆盖本次可见交互，不宣称审计了全部Messages。若当轮真实Tools或页面不可见，写具体未测原因，不根据记忆补答案。

负责人核对依据（无需放入给DeepSeek的最终Prompt）：[IDE工具声明](../demo-apps/aotui-ide/src/tui/ide-tool-contracts.ts)、[动态启用和Root说明](../demo-apps/aotui-ide/src/tui/ScopedIDEApp.tsx)、[实际文件加载／关闭／目录刷新](../demo-apps/aotui-ide/src/core/ide-session.ts)、[外部版本冲突](../demo-apps/aotui-ide/src/core/observed-file-actions.ts)、[Host公开App控制工具](../agent-driver-adapter/src/semantic-aotui-driven-source.ts)、[Driver暂停／恢复](../agent-driver-v2/src/core/agent-driver-v2.ts)、[Host按钮](../host/src/gui/components/ChatArea.tsx)、[应用预览边界](../host/src/gui/components/TuiDesktopViewer.tsx)。本次仅阅读这些实现并编写建议，没有修改生产代码、总索引或执行新的测试批次。

## 联合初稿第4～7节的简短修正意见

已阅读[SRT联合初稿](../SRT/HOST_DEEPSEEK_ACCEPTANCE_PROMPT_2026-11-09.zh-CN.md)。主流程可用，建议合并以下4处文字修正即可；不另设计计划或补工程检查。

1. **第5节：明确先测陈旧写入，再重新加载。** “重新打开／刷新文件”容易被理解成调用`refresh_workspace`，它只刷新目录树。建议替换相关操作句为：

   > 收到“已修改”后，先不要调用multi_open_file、refresh_workspace或其他读文件工具。根据当前已加载的a.ts，仅尝试一次edit_file，将A-v2改成A-v3；预期RESOURCE_CONFLICT，记录实际结果，不自动重试。若当前View已经明确呈现外部修改，就记“未构造出陈旧写入”，不冒称冲突验证通过。发生预期拒绝后，用multi_open_file重新加载a.ts，确认EXTERNAL-CHANGE仍在，再基于新读取内容正常编辑。若旧写入意外成功，记录失败，不用后续成功恢复抹去它。

   初稿对unknown／partial先核对实际状态的要求保留；正文没有自动更新本身不判失败，也不要求Runtime主动轮询磁盘。

2. **第6节：必须写成“暂停／恢复”，并实际点击Resume。** 当前按钮是`Pause Agent`／`Resume Agent`。仅发送“继续”不会解除paused；原文可能让测试一直等着。建议改为：

   > 我在Agent工作时点击Pause Agent。已经开始的一轮及其工具允许完成；暂停阻止后续轮次，不要求立即截断输出或回滚。我可以在暂停时发送“继续”，然后点击Resume Agent。恢复后，你先核对当前页面与已完成操作，再完成余下步骤。未按到暂停就记未执行。

   继续沿用初稿的三步Planning操作，无需增加其他任务或人工延迟。

3. **第4节：hover检查符号说明，定义跳转才检查位置。** “hover／定义跳转……返回指向真实符号”容易混用两种预期。建议默认选择一次`lsp_hover`，对a.ts里明确声明的函数名查询，`file_path`用绝对路径，`line`／`character`按当前Schema的一基坐标。成功时检查对应FileDetail语言面板出现匹配的函数／类型说明，Tool Result保留收据／View提示即可；不要要求hover必须返回跳转位置。若使用定义跳转，则检查目标文件及位置。工具不可用或失败时记录原始事实，其他项目继续，不把本次一条查询扩大为LSP完整资格验收。

4. **第7节：当前步骤只验证关闭View，需明确App层边界。** 建议在本轮专用IDE实例的两个测试FileDetail都关闭后，加一次`system-close_app`（app_id取当前Tools枚举），核对实际收据和下一轮App关闭状态／IDE业务页面与工具退出，再继续Planning操作，以覆盖跨App正常工作。若该IDE还承载需要保留的其他工作，就只关闭测试View，并将“IDE App关闭”记未执行。App关闭成功不等于证明所有进程、句柄或内存归零；初稿已有未覆盖说明保留。

其余无需扩展：双FileDetail路径选对象、当前View与历史聊天的区分、Planning单激活限制、旧Observation不可直接构造等表述均适合人工验收。本次是对脚本可执行性和判定边界的复核，不是实际人工验收通过记录。
