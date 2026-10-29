# 下一步仅为 C1 独立复验

建议 ChatGPT 先审查仅含一个生产文件和一个新测试的 incremental-changes.patch，再原样运行独立 v3 和普通 Schema 起点对照脚本，核对四个非法依赖成员 Handler=0、两个普通依赖保留兼容、合法顶层声明继续拒绝执行。

按最后源码状态复验六项回归、三轮定向及原始两个 R1 脚本，并重新核对 baseline.json /integrity-final.json /source-fingerprints.json。原 Wave 2C 63 个用例和 R1 29-case 文件应继续保留。由负责人决定是否签署 Wave 2C LIMITED PASS。

此步骤不授权任何 Ref 执行。通过后若另行批准实际 Ref 执行切片，仍需独立设计并验证 effectiveArgs/provenance、预算、执行 IPC 和 receivedArgs 回显合同；本轮不实现或启动它们。
