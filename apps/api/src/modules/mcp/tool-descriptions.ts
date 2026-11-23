export const REMOTE_TOOL_DESCRIPTIONS: Record<string, string> = {
  create_project: '创建一个项目，并返回可直接写入 .localehub/config.yaml 的配置（初始化用）',
  import_translations: '把一批语言文件内容写入项目（初始化用；默认 dry-run，需 confirm=true 才落库）',
  list_projects: '列出当前 token 可访问的项目',
  get_project: '读取项目详情',
  list_project_locales: '读取项目语言列表',
  search_translation_keys: '检索翻译 Key',
  get_translation_entry: '读取单条翻译条目',
  get_glossary: '读取术语库',
  upsert_glossary_terms: '提出术语（只能落成草稿，定稿由人决定）',
  extract_glossary_candidates: '从已有译文里数出候选术语与它已有的译法',
  search_translation_memory: '检索翻译记忆',
  translate_entries: '调用 AI 生成草稿译文（永不自动通过审核）',
  review_translation_entries: '提交审核决定（需要审核权限）',
  get_qa_issues: '读取 QA 问题',
  update_translation_draft: '更新译文草稿',
  submit_review: '提交审核',
  get_project_sync_status: '读取仓库同步状态',
  get_pending_platform_changes: '读取待拉取的平台变更',
  validate_release: '发布前校验',
  // The preferred input is the page itself, and saying otherwise here would contradict the tool's own
  // description and the guide. This line read 「传 ui 元素树，平台自己画图并算坐标」 for two rounds after
  // the replica path replaced it — nothing kept the two texts in step, so this one never moved.
  upload_screen_mockup: '把界面草图与每个 key 的位置传给平台（首选整页 document，平台不重画、交给浏览器渲染）',
  mark_applied: '回报已审核译文已写进仓库，平台据此停止再次下发（需 translation.apply）',
};
