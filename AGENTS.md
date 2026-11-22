<!-- project-cognition:start (managed block; edits between these markers are overwritten) -->
## 项目认知索引（project-cognition）

- 每次会话开始（项目内第一轮、做其他事之前）先调用 cognition_gate 确认项目名单状态。
- 开发前调用 cognition_overview 读取整份索引建立全局认知；大索引跟随 NEXT_CHUNK 分块读完。
- 【必须】每次对项目做出改动（代码/配置/测试/文档/数据库）之后，都要维护本索引：cognition_scan 检查漂移，cognition_update_entries / cognition_remove_entries 更新受影响条目，直到 cognition_verify 返回 aligned=true 才算完成——这不是可选项。
- 改动前想看影响面：cognition_search 传 relations=impact 与 path=目标文件（只走正式 R 关系，derived 结果仅供参考）。
- 条目语义必须依据真实源码撰写；工具只校验结构、标签与配额。
<!-- project-cognition:end -->

## 工作区提示（task-planner）

- 本插件是三插件联合开发区的一员：../shared/ 下的 agents-block、local-store、session-gate 为 workbench 与 project-cognition 共用；本插件自身零持久化、不依赖 shared/。
- 改动 shared/ 下任何模块前，先评估对另两个插件（github-workbench、project-cognition-plugin）的影响。
- 提交习惯：本仓库（task-planner）单独提交；改动若涉及 ../shared/，在提交信息中注明共享模块指纹（见 git log）。
