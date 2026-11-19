/**
 * What the Remote MCP tells a client about itself.
 *
 * The server's `instructions` is the one piece of text a client is expected to put in front of the
 * model before any tool call, so it is where "how do I use this" has to be answered. It used to be
 * two sentences describing what the server *cannot* do, and an agent connecting to it had to learn
 * the tool shapes by sending deliberately malformed calls and reading the validation errors — three
 * round trips to discover `files[0].entries[0].key`, and it never discovered the fields that have
 * defaults, which are exactly the ones that decide whether the import lands correctly.
 *
 * The guide below is deliberately specific. Vague guidance ("provide the localization files") is
 * what produced the probing; the rules that follow are the ones a caller cannot infer from the
 * schema and cannot recover from afterwards.
 */

/**
 * Server instructions: kept short because every client shows it, and every word costs context.
 * The detail lives in `localehub://import-guide`, which a client fetches only when it needs it.
 */
export const REMOTE_MCP_INSTRUCTIONS = [
  'LocaleHub：本地化平台。这里只有平台侧数据与业务工具（项目、Key、译文、术语、翻译记忆、QA、审核、同步），',
  '它无法访问开发者的本地文件系统——读写仓库文件由 CLI（localehub）或你自己的文件工具完成。',
  '',
  '两个方向，别搞反：',
  '· 仓库 → 平台：import_translations（首次导入）、CLI 的 sync push（日常）。',
  '· 平台 → 仓库：get_pending_platform_changes 读出已审核译文 → 你写进文件 → mark_applied 回报。',
  '',
  '上传（import_translations）前必读 localehub://import-guide。三条最容易出错的规则：',
  '· locale 按仓库实际目录填（zh-Hans.lproj 就传 zh-Hans）：等价的标签会归入项目已有的语言（zh-Hans → zh-CN、en → en-US），',
  '  项目没有的语言会自动新增并在返回值与审计里报告；只有「项目同时有 zh-CN 和 zh-TW，来的却是 zh」这种无法判断的情况才会被拒；',
  '· platform 默认是 web，iOS 必须显式传 ios，且要与仓库配置里的 platform 一致；项目没有这个端也会自动加上；',
  '· 一次调用只放 300~400 条，整个导入在一个 5 秒的事务里（实测 400 条通过、1000 条超时），超时会整批回滚。',
  '',
  '顺手（可选，但很值）：upload_screen_mockup 把译文放回界面里——编辑器的「界面草图」并排显示图与译文，点标记跳到译文。',
  '不管源码是什么技术栈（iOS / Android / Web / Flutter / RN），都先把它转成 HTML 传进来：平台解析出元素树，',
  '自己排版、画图、算出每个标记的坐标，颜色与组件外观按 class / inline style / <style> 还原。',
  '一套写法通吃，也不用你画图、不用你量坐标；标签栏、开关、滑块、卡片都有对应写法，见教程。',
  '节点的 text 默认就是 key（可用 key 覆盖）；指向还没导入的 key 不算错，会在 markers.unmatched 里报告，导入后自动对上。',
  '有 shell 权限时更省事：localehub mockup --page <页面文件> --confirm 读同一个页面的源码并直接上传。',
  '注意没有 dry run：同名屏幕再传一次是整体替换（旧图与旧标记不再保留），别拿它「先试一下」。细节见 localehub://screen-sketch-guide。',
  '',
  '先看不写这件事只有两个工具提供：import_translations 用 confirm=true 才落库，mark_applied 用 dry_run=true 只看结果。',
  '其余写工具（translate_entries、review_translation_entries、update_translation_draft、create_project、upload_screen_mockup）一调即写，没有预演。',
  'AI 生成的译文一律是草稿；审核与发布必须由具备权限的人类完成，Agent 的批准会被拒绝——这是设计。',
].join('\n');

/**
 * The upload guide, served as `localehub://import-guide`.
 *
 * Markdown rather than JSON because its reader is a model, and every rule here is one that a
 * caller either cannot discover from the schema (defaults are invisible) or cannot undo (a locale
 * code, a platform, a namespace are all part of a key's identity).
 */
export const REMOTE_MCP_IMPORT_GUIDE = `# 把本地语言文件上传到平台

## 0. 先读，别试错

工具的完整入参 schema 会随 \`tools/list\` 一起下发，包含类型、必填项与默认值。不要用「发一个畸形请求看报错」的方式
摸形状——报错只会告诉你**必填**字段，凡是带默认值的字段全部隐身，而这里带默认值的字段恰好是最危险的三个
（\`platform\`、\`namespace\`、\`confirm\`）。

## 1. 调用形状

\`\`\`jsonc
{
  "project_id": "<uuid>",
  "confirm": false,                       // 默认 false = 只报告不写入
  "files": [
    {
      "path": "locales/ja-JP/Localizable.strings",  // 仓库里的相对路径，仅作标识
      "locale": "ja-JP",                            // BCP 47；必须与项目 locale 完全一致
      "platform": "ios",                            // 默认 web —— iOS 必须显式传 ios
      "namespace": "Localizable",                   // 可选；多张字符串表必须靠它区分
      "entries": [{ "key": "checkout.title", "value": "お会計" }]
    }
  ]
}
\`\`\`

## 2. 三条事后难改的规则

**locale 填仓库里的实际目录名，平台会自己对齐。** 项目是权威项目已有的语言，仓库是权威它自己有哪些语言：

| 情况 | 平台怎么做 |
| --- | --- |
| 完全相同（项目有 \`zh-CN\`，你来 \`zh-CN\`） | 直接用 |
| 等价标签（项目有 \`zh-CN\`，你来 \`zh-Hans\`；项目有 \`en-US\`，你来 \`en\`） | 归入已有的那个，并在返回值 \`expansion.localesMatched\` 里报告 |
| 项目没有（项目只有 \`en-US\`，你来 \`fr-FR\`） | **自动新增**，带可读名字（\`Français（France）\`），在 \`expansion.localesAdded\` 里报告 |
| 无法判断（项目同时有 \`zh-CN\` 和 \`zh-TW\`，你来 \`zh\`） | **拒绝**并列出候选，要求传确切代码——猜错会把文本归到错误的语言下，且很难回头 |

等价判断只在脚本与地区真正互替时成立（\`zh-Hans\` ↔ \`zh-CN\`、\`zh-Hant\` ↔ \`zh-TW\`），或标签是光秃秃的语言
（\`ja\` 对上唯一的 \`ja-JP\`）。它**不会**把 \`zh-Hant\` 认成 \`zh-CN\`。

为什么这件事重要：源文是靠 \`locale === sourceLocale\` 认出来的。以前 \`zh-Hans\` 不被认成 \`zh-CN\`，于是
**一条 source version 都不生成**，译文全部 \`basedOnSourceVersionId = null\`——项目变成「有译文、没有原文」，
占位符校验、源文变更标 stale、AI 翻译都没有参照物。

**platform 决定 key 的身份。** key 的身份是 \`(项目, platform, namespace, key)\`。要与
\`.localehub/config.yaml\` 里文件映射的 \`platform\` 一致：导入成 \`web\`、之后用 \`ios\` 扫同一批文件，平台会认为是
两套不相干的 key，表现为「一批新 key + 一批待归档」，不报错。iOS 用 \`ios\`，Android 用 \`android\`，
多端共用一份文案用 \`universal\`。项目没有这个端时也会自动加上，并在 \`expansion.platformsAdded\` 里报告。
每条 key 的 platform 取它所属文件的 \`files[].platform\`（条目自带 \`platform\` 时以条目为准），所以一个文件
放什么端，是整批 key 的身份。

**多张字符串表要用 namespace 分开。** key 的身份里**没有文件路径**。iOS 的 \`Localizable\` / \`InfoPlist\` /
\`LaunchScreen\` 是三张独立的表，都用默认空 namespace 导入就是拍平成一个 key 空间，同名 key 互相覆盖（后写的赢，
不报错）。用 \`namespace\` 承载表名。

## 3. 分批，以及为什么分批是安全的

整个导入（scan → preview → push）在**一个事务**里，写入量由这一批的条数决定。超时会**整批回滚，不会写半份**，
所以失败是干净的：减小批次重跑即可。

一次调用的开销**只与这一批的条数有关，与项目已经有多大无关**。所以：

- 按「文件 × 语言」分批，每批几百条即可（一次几万条既没有必要，也会撞上请求体上限）。
- 分批**不会**把没在这一批里的 key 判成删除：导入是**部分上传**，它只说「这几个文件是这样」，
  不对其余文件表态。这一点由平台保证，不需要你做什么。
- 对未改动的值重复导入是幂等的（不产生重复版本），返回值里的 \`unchanged\` 就是这些条数。可以放心重跑。
- MCP 请求体上限 4 MB，是另一个分批的理由。

一万条 key 大约 25~30 次调用。如果某次仍然超时，那是这一批太大或数据库正忙——减小批次，不要试图一次发完。

## 4. 推荐顺序

1. \`get_project\` + \`list_project_locales\` —— 拿到 sourceLocale 与已有语言代码，**不要猜**。
2. 若 platform 不对（例如项目建成了 \`web\` 但内容是 iOS），先处理它：平台上没有任何工具能改
   \`sourceLocale\`，也没有工具能给项目加 platform；项目还是空的时候重建最便宜。\`create_project\` 接受 \`platforms\`。
3. 每个文件先 \`confirm: false\` 跑一次 dry run：核对 \`files[].isSource\`（源文判定按**归入之后**的代码算）、
   \`entryCount\`，以及 \`expansion\`——它会告诉你这次导入会新增哪些语言、把哪些标签归入已有语言、新增哪个端。
   dry run 只回答不写。
   确认导入后的返回值里还有 \`unchanged\`：本次内容与平台已有译文完全一致的条数。它不写库，所以**重跑同一个
   文件是安全的**——看这个数就知道上次是不是已经生效了。
4. 分批 \`confirm: true\` 导入，从源语言文件开始。
5. 全部导入后 \`get_project\` 看 counts，再用 \`get_qa_issues\` 跑一遍。
6. 平台 → 仓库方向：\`get_pending_platform_changes\` → 写文件 → \`mark_applied\`（需要 \`translation.apply\` scope）。

## 5. 为什么可以放心分批

MCP 的导入每次都是一次**部分上传**：它只说「这几个文件是这样」，不会说「其余文件没了」。所以按批导入不会把
没在这一批里的 key 判成删除——这一点由平台保证，不需要调用方做什么。

一次调用的开销只和**这一批的条数**有关，和项目已经有多大无关。（早先不是这样：计划里会为项目已有的每一条
都生成一个条目，于是往一个有几千条的项目里导入 1 个 key 也会超时。已修。）

## 6. 界面草图（可选，但很值）

译文缺的从来不是词，是**位置**：\`checkout.pay_now\` 到了译者手上没有按钮。\`upload_screen_mockup\` 把界面和译文
并排显示在编辑器的「界面草图」里，点标记跳到译文、选译文点亮标记。

上游该走的路是**整页复刻**：把那一屏真实的 HTML 交上来（\`document\`，或 \`html\` 里直接放整页——带
\`<!doctype html>\` 或 \`<html>\` 就算整页），平台不重画，编辑器在沙箱里照着渲染，看起来就是那个页面。
只有一段代码、没有整页时才退到片段重画（\`html\` 片段或 \`ui\` 元素树），那是近似，不是复刻。

**还原度取决于一件事：那份 HTML 是不是真实界面的 HTML。** 拿不到页面源码时最容易出的错，是照着眼睛
写一份示意图——灰条当文字、手画的形状当图标——那传上来就是线框图，译者认不出是哪个页面（平台会报
\`DRAWN_SHAPES\`）。原生界面（iOS/安卓/Flutter/RN）的布局数值和图片都在工程里，按下面的对照表读出来照抄，
图从资源目录取原件内联成 \`data:\` URI。

完整教程见 \`localehub://screen-sketch-guide\`：§0 两条路的取舍、§7 报告怎么读、**§9 逐栈对照表
（布局数值在哪、图在哪、颜色在哪）**、key 与 namespace 从哪来、上限、两件不可逆的事，
以及「让 CLI 从页面源码直接生成」（\`localehub mockup --page <页面文件> --confirm\`）。

## 7. 解析本地文件

\`.strings\` 的坑：UTF-16 + BOM、\`/* 注释 */\`、\`\\"\` \`\\n\` \`\\\\\` \`\\uXXXX\` 转义、重复 key、值里出现 \`=\`。
解析错一位，平台存下的 \`contentHash\` 就是错的，之后每次同步都会冒出假 diff。
平台的解析器（\`packages/format-adapters/src/adapters/ios-strings.ts\` 的 \`parseAppleStrings\`）可以作为行为参照。
`;

/**
 * The screen-sketch guide, served as `localehub://screen-sketch-guide`.
 *
 * Split out of the import guide rather than appended to it: the two flows share nothing but the
 * project id, and an agent asked to "show the translators where this text lives" should not have to
 * read a `.strings` parsing tutorial to learn that it does not have to draw anything.
 */
export const REMOTE_MCP_SKETCH_GUIDE = `# 把界面草图传上来：让每句译文有地方站

## 0. 一句话：整页传 \`document\`（复刻），片段传 \`html\`（重画）

**还原度最高的是整页复刻**：把页面的完整 HTML 交上来（\`document\`，或 \`html\` 里直接放整页——
带 \`<!doctype html>\` 或 \`<html>\` 就算整页）。平台不重画，原文存下来，编辑器在沙箱里照着渲染：
配色、圆角、字体、图片、背景全是页面自己的，看起来就是那个页面。素材要跟着上来：本地文件内联成
\`data:\` URI，或者用能公开访问的 \`https\` 地址。脚本会存下来但**不会执行**（沙箱里没有 allow-scripts），
所以由接口填的数据不出现——**动态数据除外**，要展示某个状态就把那个状态写成静态 HTML 或作为一帧。

**片段**（一个组件文件、一段结构）走重画：平台解析出元素树、自己排版画图并算出坐标，颜色与组件外观按
class（含 Tailwind）/ inline style / \`<style>\` 规则还原。用在没有整页、只有一段代码的时候。

**整页复刻的前提是那份 HTML 就是真实界面的 HTML**，不是照着眼睛写的一份示意图。这是这条路上唯一真正的坑：
拿不到源码时，容易退化成「画一张像它的图」——灰条当文字、手画的形状当图标——传上来就是一张线框图，
译者认不出是哪个页面，平台也会报 \`DRAWN_SHAPES\`。**原生界面也一样**：布局数值和图片都在工程里
（Auto Layout 约束、\`layout_*\`、Flutter 的 padding、资源目录里的图），按 §9 的逐栈对照表读出来照抄。

不想给源码时：\`ui\` 是自己写元素树（同样的排版与出图），\`image_base64\` + \`markers\` 是自己画图、
自己量坐标，留给设计稿和截图。

两条路都不需要量坐标：整页由浏览器量（编辑器渲染时实测每个元素），片段与 \`ui\` 由平台排版时算——
**不需要量坐标**是这两条路共同的承诺。理由很直接：页面改一行文案，手量的坐标就全废了；从页面里读出来的东西，改一行只需要重新生成一次。

## 1. 调用形状（html）

\`\`\`jsonc
{
  "project_id": "<uuid>",
  "name": "练习页",              // 屏幕的身份：同名再传 = 整体替换
  "platform": "ios",            // 这张草图的端，默认 web
  "locale": "zh-CN",            // 图里文字的语言，通常就是 sourceLocale
  "namespace": "Localizable",   // 可选；分表的项目必填，整棵树继承
  "html": "<div class='card'><h1>练习</h1><button data-key='exam.next'>下一步</button></div>"
}
\`\`\`

上面这个例子是**片段**，走重画。整页走复刻，形状一样，只是把整页 HTML 放进 \`document\`（或放进 \`html\`）：

\`\`\`jsonc
{
  "project_id": "<uuid>",
  "name": "保单列表",
  "platform": "web",
  "locale": "zh-CN",
  "document": "<!doctype html><html><head><style>body{background:#f6f7f9}</style></head><body>\\n    <div class=\\"policy-card\\" data-component=\\"policy-card\\">\\n      <h1 data-key=\\"policy.title\\">我的保单</h1>\\n      <img src=\\"data:image/svg+xml;base64,PHN2Zy8+\\" alt=\\"\\" />\\n      <button data-key=\\"policy.view\\">查看详情</button>\\n    </div>\\n  </body></html>"
}
\`\`\`

片段这条路**只解析，不渲染、不执行脚本、不联网取资源**：\`<script>\` 与注释里的内容不会被当成文案；样式只认颜色、圆角、字号、
间距、阴影、对齐这些渲染器画得出来的属性，\`hsl()\`、\`@media\`、伪类一律忽略。整页这条路则相反：页面自己的
\`<style>\`、\`@media\`、web font 全部按浏览器的方式生效，平台只是把它原样交回给浏览器。

**HTML 里的文案怎么对上 key**：给元素加 \`data-key="checkout.pay"\`（或 i18next 的 \`data-i18n-key\`）——HTML 没有
\`t('…')\` 这样的调用，不写的话标记就以文案本身为 key，只有按源文命名的项目才对得上。

### 不管源码是什么技术栈，都先转成 HTML

这是这套流程里唯一的「统一入口」：一套写法、一份教程、一个渲染器。平台存下来的不是你的 HTML，而是它自己按元素树
画出的 SVG 与标记坐标——所以以后要改画法、加主题，都不用你重新上传。

| 你的代码 | 写成 | 平台画成 |
| --- | --- | --- |
| iOS \`NavigationStack\` + \`.navigationTitle("设置")\` | \`<nav><h1>设置</h1></nav>\` | 顶栏（横跨整屏） |
| Android \`TopAppBar\` | 同上 | 同上 |
| iOS \`TabView\` / \`UITabBar\` | \`<div class="tabbar"><a>首页</a><a>保单</a><a>我的</a></div>\` | **贴屏幕底部的**标签栏 |
| Android \`BottomNavigationView\` / Compose \`NavigationBar\` | 同上 | 同上 |
| \`UISwitch\` / \`SwitchMaterial\` | \`<input type="checkbox">\`（标签写在旁边） | 开关 |
| \`UISlider\` / \`SeekBar\` | \`<input type="range">\` | 滑块（轨道 + 滑块） |
| \`List\` / \`RecyclerView\` / \`FlatList\` 的行 | \`<ul><li>…</li></ul>\` 或 \`<div class="row">\` | 一行元素 |
| \`Card\` / \`MaterialCardView\` | \`<div class="card">\` | 卡片（描边 + 圆角） |
| \`Button\` / \`MaterialButton\` / \`TouchableOpacity\` | \`<button class="bg-blue-600 text-white rounded-lg px-4 py-2">\` | 按钮（带页面配色） |
| \`TextField\` / \`TextInputLayout\` / \`EditText\` | \`<input placeholder="搜索课程">\` | 输入框（占位文案进标记） |
| \`Image\` / \`ImageView\` / \`AsyncImage\` | \`<img alt="院徽">\` | 图片占位，\`alt\` 进标记 |
| 徽标 / \`Chip\` / \`Badge\` | \`<span class="badge">已完成</span>\` | 药丸 |
| \`UISegmentedControl\` / \`SegmentedButton\` | \`<div class="tabs"><span>全部</span><span>未读</span></div>\` | 分段控件 |
| 只属于某个端的布局细节 | 用下面的 \`ui\` 元素树直接写 | 同上 |

类名不必是 Tailwind 的真类名——\`class="tabbar"\`、\`class="card"\`、\`class="btn"\` 这种写法平台都认；
颜色写 Tailwind 的（\`bg-blue-600\`）、\`#rrggbb\` 或 inline \`style\` 都行。三个选择要一次定对：
\`platform\`（ios → 画布 390×844、android → 412×915、web → 1280×800）、\`namespace\`（iOS 的多张字符串表必须写）、
以及要不要给文案挂 \`data-key\`。

### 页面自己没带颜色怎么办

手写转出来的界面常常只有语义类名（\`class="card"\`、\`class="primary-button"\`），一个颜色都没有——那样画出来只能用平台自己的灰阶。
两个办法，通常一起用：

- \`css\`：把颜色所在的那份样式表（\`globals.css\`、设计系统的主题文件）一起传上来。规则先于页面内的 \`<style>\` 生效，
  所以页面自己写的仍然优先；\`:root\` 里的变量会被解析，\`var(--brand)\` 能落到实际颜色。
- \`theme\`：直接说品牌色，\`{"accent": "#c8102e", "background": "#f7f7f9"}\`。accent 用在按钮、开关、滑块、
  以及**选中的那个页签**上。不传就按端取默认（iOS 系统蓝、Android Material 蓝、web 近黑）；页面自己带的颜色永远优先。

### 仓库里的工作目录：\`.localehub/\`

平台这一侧不碰你的磁盘，所以「Agent 往平台上放了什么」要在仓库里留痕——这就是 \`.localehub/\`：

| 文件 | 提交吗 | 为什么 |
| --- | --- | --- |
| \`.localehub/config.yaml\` | **要** | 仓库与项目的对应关系（project id、语言目录、端映射）。没有它，下一个人接不上 |
| \`.localehub/mockups/*.svg\` + \`*.json\` | **要** | 上传的那张图本身，加一份说明（哪一页、哪个屏幕、多少标记、平台的校验和）。评审时能看到 Agent 到底往平台上放了什么 |
| \`.localehub/state.json\` | 不要（已 gitignore） | 一台机器的同步游标与历史，提交上去只会互相打架 |
| \`.localehub/backups/\`\` / \`cache/\`\` / \`patches/\`\` / \`*.local.yaml\` | 不要（已 gitignore） | 本地回滚、缓存、本地覆盖 |

\`localehub mockup --page\` 会自己建目录并写这两个文件（先预览后 \`--confirm\` 上传；上传后再写一次，带上平台的校验和）。
**只用 MCP、不跑 CLI 的 Agent 也应该这么做**：把你上传的那份描述（或平台返回的图）写进
\`.localehub/mockups/\` 并一起提交——否则平台上的改动在仓库里查无实据。上传是会改共享系统的事，仓库里要看得见。

### 图片

平台**不联网取图**，所以只有带在载荷里的才画得出来：\`<img src="data:image/png;base64,…">\`（单张 ≤ 约 300 KB，合计 ≤ 约 1.2 MB）。
超限的单张退回占位框，外链与仓库路径一律是占位框——它们要真出现，就用 CLI 生成：
\`localehub mockup --page <文件>\` 会把页面引用的小图自动内联（同样有上限，跳过哪张会说明原因）。

### 一个屏幕的多个状态：\`frames\`

一个屏幕很少只有一张图：空列表、加载中、校验失败、无权限，都长着同一批 key，读起来却不一样。把这些状态
**各占一帧**排在同一张画布上，译者看到的是「这条 key 在每种状态下读起来是什么样」，而不是一张图替他代表全部。

\`\`\`jsonc
{
  "project_id": "<uuid>",
  "name": "我的保单",          // 整张画布的身份
  "platform": "ios",          // 决定每帧的尺寸：ios 390×844
  "locale": "zh-CN",
  "theme": { "accent": "#1e6fd9" },
  "frames": [
    { "title": "默认",   "html": "<div class='policy-card'>…</div>" },
    { "title": "空状态", "html": "<div class='policy-card'><span>还没有保单</span></div>" },
    { "title": "加载中", "ui": { "root": { "type": "screen", "children": [{ "type": "text", "text": "正在加载…" }] } } }
  ]
}
\`\`\`

规则简单：每帧给 \`html\` 或 \`ui\` 之一，最多 8 帧；**给了 \`frames\` 就不要再传 \`ui\` / \`html\` / \`image_base64\`**。
平台把各帧横向排开、每帧上方写状态名（那是平台的标注，不是页面文案，不会变成标记），返回值里
\`markers.frames\` 会告诉你每帧各有多少个标记。帧要挑真正影响译文的：同一个状态拆成两帧、或者凑满 8 帧，
读的人只会更糊涂。

### 组件：\`component\`

界面的「这是哪个页面」有一半是「由哪些组件拼出来的」。给元素的根写上组件名，平台会：

- 在图上给每个实例打一个编号徽章，画布底部列出编号、名字与实例数（只有一个组件时不画——那不是图例，那是标签）；
- 让**组件内部的每一条文案都归属这个组件**（继承最近的祖先），所以「这张卡上有哪些文案」是可回答的；
- 在返回值里给出 \`components: [{index, name, count}]\`，编辑器旁边就是同一份清单，点一下高亮该组件的所有标记。

名字从哪来：\`<PolicyCard>\` 这类组件名直接用；HTML 里用类名（\`class="policy-card"\`），样式工具类会被跳过；
\`data-component="PolicyCard"\` 可以覆盖两者。不写也行——只是图例里少一项。

### 也可以自己描述（\`ui\`）

\`\`\`jsonc
{
  "project_id": "<uuid>",
  "name": "练习页",
  "platform": "ios",
  "locale": "zh-CN",
  "ui": {
    "root": {
      "type": "screen",
      "children": [
        { "type": "text", "text": "亲爱的", "role": "heading" },
        { "type": "input", "text": "搜索课程" },
        { "type": "row", "columns": 2, "children": [
          { "type": "button", "text": "再想想" },
          { "type": "button", "text": "下一步" }
        ]}
      ]
    }
  }
}
\`\`\`

**外层参数说了算。** \`name\` / \`platform\` / \`locale\` 是屏幕的身份，取的是这次调用的参数。\`ui\` 里**只需要 \`root\`**
（\`width\` / \`height\` 可选，不给就按 platform 的常见屏宽：web 1280×800、ios 390×844、android 412×915）。
\`ui.name\` / \`ui.platform\` / \`ui.locale\` 收下但不作数——不要重复写一遍，写岔了也没人告诉你哪份生效。

\`ui\` 与 \`image_base64\` 二选一，同时传会被拒。传 \`ui\` 时不要再传 \`markers\`：坐标由平台算，传了也不采用。

## 2. 节点表

| type | 画成什么 | 带 \`text\` 时 |
| --- | --- | --- |
| \`screen\` | 根节点，一整屏 | — |
| \`nav\` | 顶部栏（\`text\` 是标题，\`children\` 是右侧动作） | **一个标记** |
| \`tabs\` | 分段控件 | — |
| \`section\` | 分组 | — |
| \`card\` | 卡片（\`bordered\` 可加边框） | — |
| \`row\` | 栅格，\`columns\` 决定等宽列数（1~6，默认 1） | — |
| \`text\` | 文字，\`role\` 取 heading / subheading / body / label / caption | **一个标记** |
| \`button\` | 按钮 | **一个标记** |
| \`input\` | 输入框、搜索框（\`text\` 当占位符） | **一个标记** |
| \`badge\` | 标签、药丸 | **一个标记** |
| \`image\` | 图片占位 | — |
| \`icon\` | 图标占位 | — |
| \`divider\` | 分隔线 | — |

**页面上能看到多少字符串，树里就要有多少个**，一个不漏——漏掉的句子在编辑器里没有位置，译者看不出它属于哪儿。
这就是「草图对应那个页面的所有 UI」的字面意思。列表里的每一行都要有节点：\`.map()\` 渲染出来的行是同一个模板，
按一行的文字建成一个节点就够，不要为 50 行数据画 50 个节点。

**样式**：每个节点都可以带 \`style\`，取 \`color\` / \`background\` / \`border\` / \`borderWidth\` /
\`radius\` / \`fontSize\` / \`fontWeight\` / \`align\` / \`paddingX\` / \`paddingY\` /
\`gap\` / \`shadow\`。颜色只接受 \`#rgb\`、\`#rrggbb\`、\`#rrggbbaa\`、\`rgb()\`/\`rgba()\`
与常见颜色名；不写就是这套元素本该有的样子（按钮是实心控件、卡片是描边面板），不会画成一堆灰框。

列宽交给 \`columns\`，不要用 \`width\` 手调：\`width\` 是固定像素，换个屏幕宽就错位。

## 3. 标记的 key 与 namespace 从哪来

- 节点上的 \`text\` **默认就是 key**——项目按源文命名时正是这样。
- 节点上写 \`key\` 覆盖它：项目用 \`checkout.pay_now\` 这类命名时这么做。
- \`namespace\` 写在根节点上，整棵树继承；分表的项目（iOS 的 \`Localizable\` / \`InfoPlist\`）必须写。
- 指向**尚未导入**的 key 不算错：返回值里以 \`markers.unmatched\` 报告，对应语言文件导入后标记自动对上，不用重传草图。
- 表现上：返回值的 \`markers.matchedKeys\` 是已经在平台上找到 key 的标记数。

## 4. 两件不可逆的事

1. **\`name\` 是屏幕的身份。** 同名再传一次是**整体替换**（图片与全部标记），\`replace\` 默认 \`true\`；没有 dry run，
   也没有历史版本。所以 \`name\` 用页面名（\`checkout\`、\`登录页\`），不要用 \`checkout-v2\`、\`登录页-final\` 这类会堆版本的名字。
2. **\`platform\` 默认 \`web\`。** 要与 \`.localehub/config.yaml\` 里映射的 platform 一致；同名 key 在多个端都有时，标记优先取
   这个端的那一条，取到别的端编辑器会标出来（「Key 在 web，不在 ios」）。

上限（超过会被拒，而不是截断）：一个屏幕 400 个标记、600 个节点、24 层嵌套，生成的 SVG 不超过 2 MB。
元素太多时拆成几个屏幕，别硬塞。

## 5. 最省事的做法：从页面源码生成

如果这个仓库你能跑命令，\`ui\` 描述不必手写——CLI 可以直接读页面源码：

\`\`\`bash
localehub mockup --page apps/web/src/app/projects/page.tsx --name 项目列表            # 只生成，写 .localehub/mockups/*.svg
localehub mockup --page apps/web/src/app/projects/page.tsx --name 项目列表 --confirm  # 生成并上传
\`\`\`

它扫 JSX/TSX/HTML，把页面上的每一段文字取出来做成元素树（\`t("checkout.pay", "Pay now")\` 会同时拿到 key 与文案），
把 class 与 \`<style>\` 读成颜色与字号，并打印「哪些字符串变成了标记」。不加 \`--confirm\` 不上传，正好用来先给我看一眼。
\`--platform\` / \`--locale\` / \`--namespace\` / \`--width\` / \`--height\` 与工具参数同义，\`--keys <json>\` 覆盖 key 映射。

**MCP 服务器看不到你的磁盘**（这是设计：平台永远读不到开发者的机器），所以这一步要么你用 CLI 跑，要么你自己读页面
源码、按 §2 的节点表把文字抄成树——每一个字符串都必须落在某个带 \`text\` 的节点上。

## 6. 与导入的先后

两个方向都行：先传草图、key 还没导入（\`unmatched\` 会列出来）可以，导入后自动对上；先导入再传草图也可以，
这时 \`matchedKeys\` 直接就是全部。草图不是导入的前置条件。

## 7. 传完先看 \`report\`，再决定下一次怎么传

返回值里的 \`report\` 是平台**看过自己画出来的图之后**说的话，不是对你输入的复述：\`stats\` 是图上真实有的数量
（\`pictures\` 画出来的图片/图标、\`placeholders\` 空占位框、\`sourceColours\` 页面自己贡献的颜色、\`frames\`、\`markers\`、
\`missingKeys\`、\`components\`），\`findings\` 是逐条发现的问题，每条都带 \`advice\`（要说清改哪个字段、用哪条命令）。
\`clean: true\` 就是没话说。

看懂它的关键在于：这些失败**不会报错**——上传一样成功，只是图上看不出来，所以只有 \`report\` 会告诉你。

| finding | 图上看是什么样 | 下一次怎么传 |
| --- | --- | --- |
| \`NO_PICTURES\` | 一个图片/图标都没有 | 行内 \`<svg>\` 会直接画出来；位图内联成 \`data:image/…\`；仓库里的图用 \`localehub mockup --page\`（自动内联小图） |
| \`PLACEHOLDER_PICTURES\` | 若干灰底斜线占位框 | 同上；占位框是因为图片只有 URL，平台不联网取图 |
| \`NO_SOURCE_COLOURS\` | 全是平台默认的黑白灰，看不出是哪个 App | 颜色所在的样式表用 \`css\` 字段一起传（\`:root\` 变量会解析），或 \`theme: {"accent": "品牌色", "background": "底色"}\`；class 写成 Tailwind 的也能读到 |
| \`IDENTICAL_FRAMES\` | 几帧一模一样 | 帧画的是不同状态（空列表 / 加载中 / 校验失败 / 禁用），重复的删掉 |
| \`MISSING_KEYS\` | 标记指向平台没有的 key | 不是错误：\`import_translations\` 之后自动对上；要一开始就对，给元素写 \`data-key\` |
| \`NO_COMPONENTS\` | 图例是空的，编辑器里没法按组件筛 | JSX 用组件名，HTML 用类名或 \`data-component="PrimaryButton"\` |

整页复刻（\`document\`）走的是另一套检查——那一页没有被重画，所以出问题的不是画，而是**页面自己没带的东西**：

| finding | 复刻出来是什么样 | 下一次怎么传 |
| --- | --- | --- |
| \`NO_KEYS\` | 页面渲染出来了，但一条译文都挂不上去 | 给要翻译的元素加 \`data-key="policy.view"\`（或 \`data-i18n-key\`）；位置由浏览器量，key 只能你给 |
| \`ASSETS_NOT_INLINED\` | 若干破图（相对路径没人解析） | 本地文件内联成 \`data:\` URI，或换成公开的 \`https\` 地址；\`localehub mockup --page\` 会自动内联 |
| \`NO_STYLE\` | 浏览器默认样式，像没穿衣服 | 样式表要跟着上来：\`<style>\` 内联，或把 \`<link rel=stylesheet>\` 的那份文件内容内联进去 |
| \`REMOTE_ASSETS\` | 图能出来，但依赖看图的人能访问那个域名 | 要任何环境都一样就内联；内网、要登录、已下线的地址都会变破图 |
| \`SCRIPTS_NOT_RUN\` | 由接口填的数据是空的（这是设计） | 「动态数据除外」：要展示某个状态，把那个状态写成静态 HTML（或单独一帧） |
| \`NO_PICTURES\` | 整页里没有任何图片、图标或背景图 | 与重画那条同义：图的地址要么内联、要么是浏览器能取到的地址 |
| \`DRAWN_SHAPES\` | 整页的图全是手画的形状，一张真素材都没有 → 看着像线框图 | 从工程里取真素材内联（见 §9）：iOS 的 \`Assets.xcassets\`、Android 的 \`res/drawable*\`、Flutter 的 \`assets/\`；矢量图标要照抄工程里的 \`path\`，不要自己画一个像的 |
| \`FLOW_LAYOUT\` | 整页用 flex/grid 排的，没有一处绝对定位 → 浏览器替你重排了一遍 | 每个元素按工程给的坐标写成 \`position:absolute\` + \`left/top/width/height\`（见 §9 第一条） |
| \`CLIPPED_BOX\` | 固定高度 + overflow:hidden，排到盒子外面的内容**图上不存在** | 内容多高盒子就多高，不要收口（§9 S2）；这一条丢掉的文案后面找不回来 |

只有这些：报告只说自己**看得见**的事，不会猜。自己传 \`image_base64\` + \`markers\` 时，平台手里只有那张图，
没有图上元素的坐标，所以判断不了圈得准不准——片段与 \`ui\` 由平台排版时算，整页由浏览器渲染时实测，
两条路都不需要你量。

**先看 \`report\`，再决定重传**：重画那条路上出现 \`NO_PICTURES\` / \`NO_SOURCE_COLOURS\` / \`IDENTICAL_FRAMES\`，
整页那条路上出现 \`NO_KEYS\` / \`ASSETS_NOT_INLINED\` / \`NO_STYLE\`，都说明还没达到「看得出是哪个页面」，
值得改输入再传一次（同名重传是整体替换，不留旧版本，所以直接改就行）。
\`clean: true\` 或只剩 \`MISSING_KEYS\` 就可以继续下一步，不必为了好看反复重传。

## 8. 整页复刻：什么时候用、素材怎么跟着走

**什么时候用它**：调用端手上有页面的完整 HTML（保存的页面、SSR 渲染出来的那一份、或者能跑起来的预览），
而「看起来像不像那个 App」重要。片段重画永远只是近似：字体是平台的、渐变和阴影是近似值、图标要靠内联 SVG。
复刻没有这层损耗——渲染它的是浏览器，就是平时渲染这个页面的那个。

**素材怎么跟着走**（平台永远不联网取资源，这是设计）：

| 素材 | 怎么写 | 结果 |
| --- | --- | --- |
| 图标 / 插图（矢量） | 行内 \`<svg>\`，或 \`data:image/svg+xml;base64,…\` | 跟着页面一起到，任何环境都一样 |
| 位图 | \`data:image/png;base64,…\` | 同上；\`localehub mockup --page\` 会把仓库里的图自动内联 |
| 样式表 | \`<style>\` 内联，或 \`<link rel=stylesheet>\` 指向的文件内容内联 | 配色、间距、响应式断点全部按浏览器的方式生效 |
| 字体 | \`data:\` 的 \`@font-face\`，或公开的 \`https\` 字体地址 | 字体由看图的浏览器取，平台不取 |
| 公开 CDN 上的图 | 直接写 \`https://…\` | 浏览器取得到就显示；内网、要登录、已下线的地址会是破图 |

**脚本不会执行**：沙箱里没有 \`allow-scripts\`，所以 \`<script>\`、\`onclick\`、\`javascript:\` 都不会跑，
由它们填的数据（列表、金额、时间）不会出现——这是刻意的，也是「动态数据除外」的意思。页面照样能排版、
照样能显示 CSS 里写死的内容与骨架屏；要让某个状态有真实内容，就把那个状态写成静态 HTML。

**状态（\`frames\`）**：整页的每一帧都是一份完整 HTML（\`frames[].document\` 或 \`frames[].html\`），
编辑器一次显示一帧、按帧切换；重画那条路是几帧并排在一张画布上。两边的 key 与文案对照是一样的。

**位置不用你给**：编辑器渲染这一帧时，自己量每个 \`data-key\` 元素的矩形并画框。所以整页这条路，
返回值里的标记坐标一律是 0——那不是「在上角」，是「等浏览器量」。

## 9. 复刻的交付标准（S1–S10）：不要照着印象画，数值和素材都从工程里读

**这一节是「还原度」的全部**。平台收到的是 HTML，读不懂 Swift / Kotlin / Dart / JSX——**能读懂工程的只有你**。
你按印象估一个「差不多」的界面，译者看到的就是一张线框图。以下是这一页**必须满足的标准**，逐条对照；
括号里是平台用来判定它的 finding。

**画布**

- **S1** 一屏一帧；画布尺寸 = 那一屏（ios 390×844、android 412×915、web 1280×800）。
- **S2 画布不许裁掉内容。** 内容多高，盒子就多高；不要用 \`height:844px\` + \`overflow:hidden\` 收口。
  被裁掉的文案**在渲染之前就没了**，图和列表都找不回来。（\`CLIPPED_BOX\`）
- **S3** 每一帧的内容都在画布之内，没有元素被排到画面之外。

**布局**

- **S4 每个元素绝对定位。** 容器 \`position:relative\`，元素 \`position:absolute\` + \`left/top/width/height\`，
  数值取自工程：Auto Layout 的 \`frame\`、\`layout_*\`、Flutter 的 \`padding\`/\`SizedBox\`、RN \`StyleSheet\` 里就是这些数。
  **不许用 flex/grid/流式排版**——浏览器的排版引擎不是设备的那个，字体字号差一点整块就挪走，而且错得不明显。
  （\`FLOW_LAYOUT\`）
- **S5 每个盒子容得下它自己的文字。** 宽度宁可写大一号，也不许文字被截断、换行、压到旁边的元素上。
- **S6** 默认不重叠；原界面本来就重叠的，用 \`z-index\` 写清楚。

**文案**

- **S7 每个要翻译的字符串都挂 \`data-key\`**，值是**工程里的真实 key**，不是原文。（\`NO_KEYS\`）
- **S8** 不翻译的东西**不要**挂 key：数字、\`3/5\`、\`12\`、\`—\`、\`（由接口下发）\` 这类占位。
- **S9** 字号、字重、行高、颜色按工程写，不要用浏览器默认的 14px。（\`NO_STYLE\`）

**素材**

- **S10 图片和图标从工程的资源目录取原件**，内联成 \`data:\` URI；矢量图标照抄工程里的 \`path\`，
  不要照着截图重画一个像的。（\`DRAWN_SHAPES\`、\`ASSETS_NOT_INLINED\`）

**上传前自检（必做）**：在浏览器里打开这份 HTML，和原界面并排，**每个状态都看一遍**，回答四个问题：

1. 有没有内容被滚出画面或者被容器裁掉了？（S2、S3）
2. 有没有文字被自己的盒子截断，或者压到别的元素上？（S5、S6）
3. 有没有该是图的地方是一个灰块或手画的形状？（S10）
4. 有没有元素跑到画布外面去了？（S3）

四个都答「没有」才传。传完读 \`report\`：还有 finding 就照 \`advice\` 改，同名重传。

| 技术栈 | 布局数值在哪 | 图在哪 | 颜色/字号在哪 |
| --- | --- | --- | --- |
| iOS（SwiftUI） | \`.padding(16)\`、\`.frame(width:height:)\`、\`VStack(spacing:12)\`、\`HStack\`、\`Spacer()\` | \`Assets.xcassets/*.imageset\`（1x/2x/3x 的 PNG，或 PDF 矢量） | \`Assets.xcassets\` 里的 colorset、\`.font(.system(size:17, weight:.semibold))\` |
| iOS（UIKit / storyboard） | storyboard/XIB 里每个 \`<constraint firstItem=… secondItem=… constant=…>\`、\`frame\`、\`UIStackView\` 的 \`spacing\`/\`layoutMargins\`；代码里的 \`NSLayoutConstraint\`/\`anchor\` | 同上 | \`UIColor(named:)\`、\`UIFont\` 的字号字重 |
| Android | \`layout_width\`/\`layout_height\`、\`layout_constraint*\`、\`layout_margin*\`、\`padding*\`、\`textSize\`（sp）、\`app:layout_constraintGuide\` | \`res/drawable*\`（**vector drawable 的 \`<path android:pathData>\` 可以直接变成内联 \`<svg><path d>\`**）、\`res/mipmap*\` | \`res/values/colors.xml\`、\`res/values/dimens.xml\`、\`res/values/styles.xml\`（主题里的 \`colorPrimary\` 等） |
| Flutter | \`Container(padding:, margin:, width:, height:)\`、\`SizedBox\`、\`Row/Column\` 的 \`spacing\`、\`EdgeInsets\` 的数值 | \`assets/\`（pubspec.yaml 里声明的那些） | \`Theme.of(context)\` 的 \`colorScheme\`/\`textTheme\`、\`TextStyle(fontSize:)\` |
| React Native | \`StyleSheet.create({…})\` 里的数值、\`flexDirection\`、\`gap\` | \`Image source={require('./x.png')}\` 指向的文件 | 样式表里的色值、\`fontSize\` |
| Web（React/Vue/…） | 组件源码与 CSS 本身 | 构建产物里的同目录文件 | 同上；\`localehub mockup --page <构建好的页面>\` 会自动内联样式表、\`<img>\`、\`srcset\` 与 CSS \`url()\` |

**做完自检**：页面里每一个「本该是图」的地方，是不是都以 \`data:\` 出现；把 HTML 在浏览器里打开，
和原界面并排看一眼。看不出是哪个页面，就不要传——平台会把 \`DRAWN_SHAPES\` 报回来，你还是得重做一遍。

## 10. 四条容易踩错的约定（调用端实测回来的）

**① key 里有换行：写真换行，不要写转义。** 本地化文件里是 \`\\n\` 转义、运行时是真换行，而 HTML 属性里怎么写
平台没有规定过，实测结果是：

| 属性里写成 | 平台读到的 key | 对得上吗 |
| --- | --- | --- |
| 真换行（属性值里直接断行） | 第一行⏎第二行 | ✅ |
| \`&#10;\` | \`第一行&#10;第二行\` | ❌ 平台不解实体 |
| 字面 \`\\n\` 两个字符 | \`第一行\\n第二行\` | ❌ |

**② key 首尾的空格是 key 的一部分。** 真实字符串表里有 \`"如需变更学习设备，点击 "\`（句尾带空格）这种 key。
平台**原样读** \`data-key\`，不裁剪——所以属性里也必须把那一个空格写上，少一个就对不上、报 \`MISSING_KEYS\`；
\`MISSING_KEYS\` 的 \`keys\` 字段会直接告诉你是哪几条，不用再去猜。

**③ \`stats.components\` 是「组件名的个数」，\`legend[].count\` 是「实例数」。** 同一个组件名出现 20 次，
\`components\` 记 1、该条 legend 的 \`count\` 记 20。\`NO_COMPONENTS\` 只在**整页一个组件名都没有**时出现——
组件名写在没挂 key 的元素上也算数（判据读的是标记里的组件名，不是图例）。

**④ 「图片名本身走本地化表」是调用端的职责。** 有些项目把图片名也做成 key（\`verify_shenfen → verify_shenfen_hans\`，
不同语言映射到不同的图）。平台只认「内联成 \`data:\`」这一件事，不做映射，也看不到你的资源目录。请在上传前
自己把 \`语言 → 图片文件\` 解析成 \`data:\` URI：

\`\`\`js
const src = assetFor(locale, 'verify_shenfen');   // 你的映射表
const html = \`<img src="data:image/png;base64,\${readFileSync(src).toString('base64')}">\`;
\`\`\`

**⑤ 把「这个数字是怎么算出来的」写进注释。** S1–S10 能验「自洽」，验不了「像不像」：一个元素整体下移 20pt，
上面每一条规则照样全过。所以把关键数值的依据写成 HTML 注释留在页面里——
\`<!-- y=91: 列表起点 = contentY(navHeight 44 + header 47) -->\`——复核的人顺着注释就能核，
比事后猜你当时怎么算的快得多。

## 11. 本地就能验：\`localehub mockup check\`

\`localehub mockup check <file.html>\` 跑的是**平台同一套规则**（同一个分析器），不写文件、不上传，
有问题就退出码非零：

\`\`\`
$ localehub mockup check screen.html
检查完毕（整页复刻，1 帧，16 个标记）：2 条必须改：
  · CLIPPED_BOX 1 处盒子设了固定高度 + overflow:hidden：排到它外面的内容，图上不存在
  · FLOW_LAYOUT 3 处用 flex/grid 排版，整页没有一处绝对定位：这是重排，不是那一屏
FAIL
\`\`\`

warning 级的 finding 会让它失败（info 不会），所以可以在提交前、CI 里卡住「本地过、平台不过」；
传上去之后平台的 \`report\` 是同一份结果，两次不会不一致。
`;

/**
 * The prompt body for the sketch flow, registered as `upload-screen-sketch`.
 *
 * Same contract as `remoteImportPrompt`: it sends the agent to the guide for the rules instead of
 * restating them, so the two cannot drift.
 */
export function remoteSketchPrompt(args: { projectId?: string; page?: string } = {}): string {
  const project = args.projectId ? `project_id=${args.projectId}` : '先调 list_projects 拿到 project_id';
  const page = args.page ?? '要画的那个页面';
  return [
    `把 ${page} 的界面草图传到 LocaleHub（${project}），让译者在编辑器里对着界面看译文。`,
    '',
    '**交付标准 S1–S10 是硬性的，逐条对照；不满足就不要传。** 完整版在 localehub://screen-sketch-guide 的 §9。',
    '',
    '按这个顺序做，不要跳步：',
    '1. 读 localehub://screen-sketch-guide。§9 是交付标准（每条后面括号里是平台用来判定它的 finding），§7 是 finding 对照表。',
    '2. 能跑命令就用：localehub mockup --page <页面文件> --name <屏幕名> 先生成预览，把「哪些字符串变成了标记、用了哪些颜色」报给我确认，再加 --confirm 上传。',
    '3. 不能跑命令，就交那一屏**真实的 HTML**：upload_screen_mockup 传 document（整页，平台不重画，编辑器照浏览器的方式渲染）。',
    '   原生界面也一样——布局数值和图片都在工程里（Auto Layout 约束 / layout_* / Flutter 的 padding / RN 的 StyleSheet）。写的时候按标准：',
    '   · 画布尺寸就是那一屏，**内容多高盒子就多高**：不要 height:844px + overflow:hidden，排到盒子外面的内容在图上不存在（CLIPPED_BOX）；',
    '   · 每个元素 position:absolute + left/top/width/height，数值照抄工程，**不要用 flex/grid 让浏览器替你排**（FLOW_LAYOUT）；',
    '   · 每个盒子容得下它自己的文字，宁可写大一号，不许文字被截断或压到旁边的元素上；',
    '   · 每个要翻译的字符串挂 data-key，值是**工程里的真实 key**；数字、「3/5」「—」这类不翻译的不要挂；',
    '   · 图片和图标从工程资源目录取原件、内联成 data: URI，矢量照抄工程里的 path，**不要照着眼睛画一个像的**（DRAWN_SHAPES）。',
    '4. 调 get_project 确认 sourceLocale 与 platforms；草图的 locale 用 sourceLocale，platform 用页面所属的端（ios / android / web），',
    '   分表的项目还要给 namespace（iOS 的 Localizable / InfoPlist）。',
    '5. 调 upload_screen_mockup：整页传 document（首选）；只有一段代码时传 html 片段或 ui；',
    '   自己画的图（设计稿、截图）才用 image_base64 + markers，并且只有这一种才要给标记。',
    '   不要传 markers 配 html / ui / document——坐标由平台排版时算、或由浏览器渲染时量，给了也不会采用；',
    '   一次只用一种输入，name 用页面名，不要用版本号。',
    '6. **上传前自检（必做，不是可选）**：在浏览器里打开这份 HTML，和原界面并排，**每个状态**看一遍，四个问题都答「没有」才传——',
    '   有没有内容被容器裁掉或者滚出画面？有没有文字被自己的盒子截断、或者压到别的元素上？',
    '   有没有该是图的地方是一个灰块或手画的形状？有没有元素跑到画布外面？',
    '7. 把返回值里的 markers.total / markers.matchedKeys / markers.unmatched 报给我：unmatched 说明这些 key 还没导入，先传草图没问题，导入后会自动对上。',
    '8. 读同一个返回值里的 report：它是平台看过这一页之后的结论（stats 里 pictures / shapes / positioned / flow / clipped 是页面上真实的数量，findings 每条带 advice）。',
    '   CLIPPED_BOX（内容被裁掉）、DRAWN_SHAPES（图全是手画的形状）、FLOW_LAYOUT（用 flex/grid 重排的）、NO_PICTURES、PLACEHOLDER_PICTURES、',
    '   NO_SOURCE_COLOURS、IDENTICAL_FRAMES 都说明还没达到「看得出是哪个页面」，按 advice 改输入后同名重传，再把新的 report 报给我；',
    '   clean 或只剩 MISSING_KEYS 就可以收工。',
    '',
    '注意：upload_screen_mockup 没有 dry run，同名屏幕会被整体替换（含旧标记），上传前把屏幕名与端再确认一遍。',
  ].join('\n');
}

/**
 * The prompt body for the upload flow. Registered as a prompt so a person can invoke it from their
 * client, and written so that pasting it into any agent produces the same sequence.
 */
export function remoteImportPrompt(args: { projectId?: string; localesDir?: string } = {}): string {
  const project = args.projectId ? `project_id=${args.projectId}` : '先调 list_projects 拿到 project_id';
  const dir = args.localesDir ?? '仓库里的语言资源目录';
  return [
    `把 ${dir} 下的语言文件上传到 LocaleHub（${project}）。`,
    '',
    '按这个顺序做，不要跳步：',
    '1. 读 localehub://import-guide，它是这个流程的权威说明。',
    '2. 用你自己的文件工具读语言文件，解析成 key/value（注意 UTF-16 BOM、注释、转义、重复 key）。',
    '3. 调 get_project 与 list_project_locales，拿到 sourceLocale 和已有语言代码。',
    '4. 决定两件事并说明理由：每个文件用哪个 locale（必须与项目里的代码逐字符相同）、用哪个 platform。',
    '5. 先 confirm=false 跑 dry run，把 isSource 判定与条目数报给我确认。',
    '6. 我确认后，按每批 300~400 条分批 confirm=true 导入，从源语言文件开始。',
    '7. 导入完成后调 get_project 核对 counts，并跑一次 get_qa_issues。',
    '',
    '任何一步发现 platform 或 locale 与项目现状不符，先停下来告诉我——这两样是 key 身份的一部分，导完再改要重导。',
  ].join('\n');
}
