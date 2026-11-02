// mods/visualizer-jump/jumpSettings.mjs
// 跳一跳的旋钮。宿主按这份 schema 渲染表单、校验、持久化，并随视觉配置一起导入导出；
// 模组只走 `ctx.getSettings()` 读值（默认值宿主已并入），所以这里不需要自己存取。
//
// key / 范围 / 默认值只有这一份，client.mjs 的 readKnobs 必须与它一致——
// 两边各写一遍就会漂移成「面板显示一个数、画面用的是另一个数」。

/** 分组：先决定镜头怎么摆，再决定路怎么铺，然后决定字贴在哪，再是译文，最后是小人与外观。 */
const GROUPS = {
    camera: { 'zh-CN': '镜头', en: 'Camera' },
    course: { 'zh-CN': '跳台', en: 'Pillars' },
    text: { 'zh-CN': '文字', en: 'Text' },
    translation: { 'zh-CN': '译文', en: 'Translation' },
    motion: { 'zh-CN': '小人', en: 'Runner' },
    look: { 'zh-CN': '外观', en: 'Looks' },
};

const number = (key, group, label, description, min, max, step, defaultValue) => ({
    key,
    type: 'number',
    group,
    label,
    description,
    min,
    max,
    step,
    defaultValue,
});

const boolean = (key, group, label, description, defaultValue) => ({
    key,
    type: 'boolean',
    group,
    label,
    description,
    defaultValue,
});

const select = (key, group, label, description, options, defaultValue) => ({
    key,
    type: 'select',
    group,
    label,
    description,
    options,
    defaultValue,
});

export const JUMP_SETTINGS_SCHEMA = [
    number(
        'pitch', GROUPS.camera,
        { 'zh-CN': '俯角', en: 'Camera pitch' },
        { 'zh-CN': '镜头往下看多少度。角度越大，地面铺得越开——台阶更陡、两行离得更远，柱身与小人在屏幕上越矮；角度越小越接近平视，路挤在一起、柱子显得更高。**只改投影的形状，不改画面缩放**：格子大小按参照俯角（默认值）封顶，所以往下调不再把画面整体放大。要更大 / 更小请用「镜头距离」。它同时决定译文的**变形量**（见「译文透视」）：俯角大则变形小。默认 34°。', en: 'How far the camera looks down, in degrees. Higher spreads the ground out (steeper steps, wider gaps between lines) and shortens pillars and the runner on screen; lower flattens it toward eye level with taller pillars. **It only reshapes the projection, never the zoom**: the cell size is capped at the reference pitch (the default), so lowering it no longer scales the whole frame up. Use Camera distance for that. It also sets how strongly the translation is warped (see Translation perspective): a higher pitch warps it less. Default 34.' },
        18, 60, 1, 34,
    ),
    number(
        'cameraDistance', GROUPS.camera,
        { 'zh-CN': '镜头距离', en: 'Camera distance' },
        { 'zh-CN': '画面缩放：1 是参照俯角定下的那一版取景，调大 = 镜头拉远（整条路更小、看得更全，格子最多缩到 60%），调小 = 推近（字更大，最多放大到 1.67 倍）。以前缩放跟着俯角一起变，于是拖俯角像在变焦；现在缩放只认这一根，俯角只管投影的形状。**它只缩放柱子、小人与那条路**：浮在画面上的译文不跟它走，译文的字号只由俯角与「译文字号」定。默认 1。', en: 'Zoom of the frame: 1 is the framing the reference pitch defines; higher pulls the camera back (smaller road, more of it in view, down to 60%), lower pushes in (bigger words, up to 1.67×). The zoom used to ride on the pitch, so dragging that slider felt like a zoom; now only this knob scales, and the pitch only reshapes the projection. **It scales the pillars, the runner and the road only**: the translation floats on top of the frame and does not follow it — its size comes from the pitch and Translation size alone. Default 1.' },
        0.6, 1.8, 0.05, 1,
    ),
    number(
        'spacing', GROUPS.course,
        { 'zh-CN': '柱子间隙', en: 'Pillar gap' },
        { 'zh-CN': '两块之间留多宽的空当（格）。块按字宽定长度，间隙只决定跳多远；行首行尾各留半个间隙，下一行从上一行的拐点外面起步，拐角处两块就不会叠在一起。默认 1.2。', en: 'Empty gap between two blocks, in cells. Blocks size themselves from their text, so the gap only sets how far a hop is; half a gap is kept at both ends of a row, and the next row starts just outside the previous row’s corner, so the two blocks at a corner never overlap. Default 1.2.' },
        0.1, 6, 0.05, 1.2,
    ),
    number(
        'pillarHeight', GROUPS.course,
        { 'zh-CN': '柱子高度', en: 'Pillar height' },
        { 'zh-CN': '柱顶离地多高（格）。高柱子让跳台像悬浮的方块，矮柱子更像地基。**字多大也由它定**：柱顶那块面跟着柱高一起长，字盒是面的固定几成，于是调高柱子 = 调大字号（字与面同比例，永远不会顶出框）。柱高是整屏一个数，不跟着字长变；文字贴在侧面时，柱高就是端头那面墙的高，柱子会在这个值上再长一档，字才装得下——字多的块只把那面墙撑宽，不会把柱子顶得更高。默认 1.9。', en: 'How tall pillars stand, in cells. Tall ones read as floating blocks, short ones as footings. **It also sets the type size**: the top face grows with the height and the type box is a fixed share of that face, so a taller pillar means bigger words (box and face scale together, so words never spill). The height is one number per screen and never follows the words; with the text on the side face this is the end wall’s height, raised one notch so the words fit — a longer word only widens that wall, it never makes a taller pillar. Default 1.9.' },
        0.2, 3, 0.05, 1.9,
    ),
    number(
        'restGap', GROUPS.course,
        { 'zh-CN': '歇脚柱', en: 'Rest pillar' },
        { 'zh-CN': '两行之间隔了多久（秒）就在行末立一根**无字的圆柱**：唱完最后一个字，小人跳到它上面歇着，下一行开口前才起跳——间奏里他歇在自己这一行的行末，不会提前站到下一行首块上。0 = 只要两跳塞得下就立（空档再窄就没有站的时间，那时直接跨到下一行首块）；默认 1.75。', en: 'How long a gap between two lines (seconds) must be before a **blank cylinder** stands at the end of the row: when the line is sung he hops onto it and rests there until just before the next line starts, so during an interlude he waits at his own row’s end instead of standing on the next row’s first block. 0 = stand one whenever the two hops fit (a gap narrower than that has no room to stand, and he simply crosses over); default 1.75.' },
        0, 10, 0.05, 1.75,
    ),
    number(
        'pillarSpring', GROUPS.course,
        { 'zh-CN': '柱子弹性', en: 'Pillar bounce' },
        { 'zh-CN': '柱子受力后的那一下：小人**落地**把它踩沉下去（默认沉 0.45 格），**起跳**时它弹回来、冲过头一点，再做几下越来越小的振动（约 1 秒内停住）。默认 1；0 = 柱子纹丝不动（老样子），2 = 夸张的一沉一弹。小人踩在柱顶上，所以他跟着柱子一起沉、一起弹。', en: 'How much the pillars react to the runner: on **landing** the block is pressed down (0.45 cells by default), on **take-off** it springs back, overshoots a little, then jitters in ever smaller swings until it settles (within about a second). Default 1; 0 keeps the pillars perfectly still, 2 is an exaggerated dip and spring. The runner stands on the top face, so he sinks and springs with it.' },
        0, 2, 0.05, 1,
    ),
    select(
        'textFace', GROUPS.text,
        { 'zh-CN': '文字所在面', en: 'Text face' },
        { 'zh-CN': '字贴在方块的哪一个面上：顶面（躺在柱顶，随投影斜切）、正面（沿路那一长条面）、侧面（端头那面，字立着读）或悬浮在柱子上方（不随面变形，最好读）。柱子跟着字长：那一面按这块字的长宽比反推大小，所以字永远装得下、永远正正落在面心（四档面同一套算法）。顶面 / 正面那档块沿路变长、柱顶跟着变宽；侧面那档只有端头那面墙跟着字宽，沿路的柱身厚度固定，柱子于是是一根长方块而不是方柱；悬浮那档柱顶跟着长宽。', en: 'Which face the words sit on: the top face (lying flat, sheared by the projection), the front face (the long face along the road), the side face (the end cap, where the words read upright) or floating above the block (upright, easiest to read). Blocks grow with their words: the face is derived from the type box’s aspect, so the words always fit and always land dead centre on that face — the same rule for all four faces. Top and front blocks lengthen along the road and widen the top face; on the side face only the end wall follows the words while the depth along the road stays fixed, so a pillar stays a long block instead of a cube; the floating face grows the top face with it.' },
        [
            { value: 'top', label: { 'zh-CN': '顶面', en: 'Top' } },
            { value: 'front', label: { 'zh-CN': '正面（沿路那面）', en: 'Front (along the road)' } },
            { value: 'side', label: { 'zh-CN': '侧面（端头）', en: 'Side (end cap)' } },
            { value: 'above', label: { 'zh-CN': '上方（悬浮）', en: 'Above (floating)' } },
        ],
        'top',
    ),
    number(
        'chunkChars', GROUPS.course,
        { 'zh-CN': '每块字数', en: 'Chars per block' },
        { 'zh-CN': '一根柱子最多写几个字（**只对中文有用**）：2 是一两个字的碎步（默认），3 / 4 是一块扛三四个字，柱子更长、跳得更少；1 想让每个字跳一次，但长句里会被「一行最多几块」的上限夹回 2（10 个字的句子至少 2 字一块）。英文只在空格处断，一个单词整根柱子扛下来，这个旋钮对英文不起作用。', en: 'How many characters one pillar may hold (**Chinese only**): 2 gives blocks of one or two (default), 3 / 4 put three or four on a pillar for longer blocks and fewer hops; 1 wants one hop per character, but on long lines the "blocks per row" ceiling pushes it back to 2 (a 10-character line is at least two characters per block). English only breaks at spaces and keeps a whole word on one pillar, so this has no effect there.' },
        1, 4, 1, 2,
    ),
    number(
        'preferPair', GROUPS.course,
        { 'zh-CN': '长词切细', en: 'Split long words' },
        { 'zh-CN': '1 = 超过「每块字数」的中文词再切小（推荐），0 = 一个词一块，长句会变得笨重。英文单词无论开不开都不拆。', en: '1 splits Chinese words longer than "chars per block" (recommended); 0 keeps a whole word on one pillar and makes long lines heavy. English words are never split either way.' },
        0, 1, 1, 1,
    ),
    select(
        'translationMode', GROUPS.translation,
        { 'zh-CN': '译文显示', en: 'Translation' },
        { 'zh-CN': '画面中部显示这一句的**译文**（不带逐字动画，换句时轻轻淡进来）。柱顶的字照旧跳，这一层只是浮在柱子后面的一块注解——柱子和小人压在它上面，所以它永远不会盖住正在跳的那一行。罗马音那一档取的是同一句的罗马音。', en: 'Draws this line’s **translation** across the middle of the frame (no per-word animation; it only fades in when the line changes). The pillars keep hopping either way, and they sit in front of it, so this layer never covers the row being sung. The romanization option shows this line’s romanization instead.' },
        [
            { value: 'translation', label: { 'zh-CN': '显示译文', en: 'Translation' } },
            { value: 'romanization', label: { 'zh-CN': '显示罗马音', en: 'Romanization' } },
            { value: 'off', label: { 'zh-CN': '不显示', en: 'Off' } },
        ],
        'translation',
    ),
    number(
        'translationSize', GROUPS.translation,
        { 'zh-CN': '译文字号', en: 'Translation size' },
        { 'zh-CN': '译文的字号（相对柱顶那块字）。一比一就与柱子上的字一样高；再大一档就要往两边折行，行数上限到了字号会自己收一档——装不下的字不会凭空消失，只会缩到看得清为止。尺子取的是**镜头距离为 1** 时柱顶那块字：推近拉远只放大柱子，译文不跟着变（只有「俯角」会同步改它）。', en: 'Type size of the translation, relative to the words on the pillars. At 1 it stands as tall as a pillar’s word; larger means more rows (and the size steps down once the row cap is reached — nothing is dropped, it only shrinks until it reads). The yardstick is that word at **camera distance 1**: pulling the camera in or back scales the pillars only, never the translation (only the pitch also moves it).' },
        0.5, 3, 0.05, 1.05,
    ),
    number(
        'translationRows', GROUPS.translation,
        { 'zh-CN': '最多几行', en: 'Row cap' },
        { 'zh-CN': '这块译文最多折几行：到了上限就缩小字号（不会丢字）。三行以上会盖到柱子顶上的字，画面挤的时候调小一档。', en: 'How many rows the translation may wrap into before its size steps down (no text is dropped). Three or more rows reach the words on the pillars; turn it down when the frame feels crowded.' },
        1, 5, 1, 3,
    ),
    select(
        'translationAlign', GROUPS.translation,
        { 'zh-CN': '译文排版', en: 'Translation alignment' },
        { 'zh-CN': '整块译文钉在画面的哪一头，也决定它钉住自己哪一头。**顶部对齐**（默认）：第一行的上边缘贴着窗口上沿，多折出来的行往下长；**中心对齐**：块心落在窗口正中，行数变了上下各长一半；**底部对齐**：最后一行的下边缘贴着窗口下沿，多的行往上长——和画面底部那条字幕的位置一致。「排版偏移」是在这个位置上再挪多少，两者互不抢戏。', en: 'Which edge of the frame the block is pinned to, and which end of itself it pins there. **Top** (default): the first row’s top edge sits on the frame’s top edge, extra rows grow downward; **Center**: the block’s middle sits in the middle of the frame, growing both ways; **Bottom**: the last row’s bottom edge sits on the frame’s bottom edge with extra rows growing upward, in line with a bottom subtitle. The offset slider then moves it from there — neither knob steals the other’s job.' },
        [
            { value: 'top', label: { 'zh-CN': '顶部对齐', en: 'Top' } },
            { value: 'center', label: { 'zh-CN': '中心对齐', en: 'Center' } },
            { value: 'bottom', label: { 'zh-CN': '底部对齐', en: 'Bottom' } },
        ],
        'top',
    ),
    number(
        'translationOffset', GROUPS.translation,
        { 'zh-CN': '排版偏移', en: 'Offset' },
        { 'zh-CN': '把整块译文往上 / 往下挪多少，**单位是窗口高度**：0 就钉在「译文排版」说的那条线上——顶部对齐时第一行的上边缘正好贴着窗口上沿，底部对齐时最后一行的下边缘贴着下沿，中心对齐时块心落在窗口正中。正值往上、负值往下，±0.8 就挪掉 0.8 个窗口高，够把字整个拉出画面。默认 0。', en: 'How far the block moves up or down, **in window heights**. At 0 it sits exactly on the line its alignment names — top alignment puts the first row’s top edge on the frame’s top edge, bottom alignment puts the last row’s bottom edge on the bottom edge, centre puts the block’s middle in the middle of the frame. Positive moves up, negative down; ±0.8 shifts it by 0.8 of the window height, enough to push the type off screen. Default 0.' },
        -0.8, 0.8, 0.05, 0,
    ),
    number(
        'translationOpacity', GROUPS.translation,
        { 'zh-CN': '译文透明度', en: 'Translation opacity' },
        { 'zh-CN': '译文有多实。80% 是默认：字读得清，又看得出柱子从字后面过。调到 100% 就是一层实心的注解，调低则更像印在背景上的一层底纹。', en: 'How solid the translation reads. 80% by default: legible, while the pillars still pass behind it. 100% is a solid gloss; lower reads as a watermark.' },
        0.15, 1, 0.05, 0.8,
    ),
    select(
        'translationPerspective', GROUPS.translation,
        { 'zh-CN': '译文透视', en: 'Translation perspective' },
        { 'zh-CN': '译文要不要跟着「镜头」的俯角往地面里倒——它本来就该是一层铺在脚下的地砖。「关闭」是正面对着镜头的一片字（最好读）；「整体」把整块字当一张平面一起压扁；「逐字」让透视作用到每个字上，一行行躺在地上的那种。**变形量由俯角同步给**：俯角大（更接近俯视）时这块字更像正对着镜头的一片、压扁与侧倾都很浅，读得更清；俯角小（更接近平视）时它被压得更扁、歪得更厉害、近大远小也更明显，真像远处地上的一条。默认俯角那一档就是这一直以来的样子，不另设角度。', en: 'Whether the translation tips into the ground by the camera pitch — it is a sheet lying underfoot. Off keeps the words square to the screen (easiest to read); Whole flattens the block as one plane; Per glyph warps each character, as rows of type really would lie on the ground. **How strong the warp is comes from the pitch**: a high pitch (closer to looking straight down) leaves the block nearly square to the screen with only a shallow squash and lean, so it stays easy to read; a low pitch (closer to eye level) squashes it harder, leans it further and deepens the near-big/far-small taper, like a strip of type on distant ground. The default pitch is exactly what this has always looked like — no second angle.' },
        [
            { value: 'off', label: { 'zh-CN': '关闭', en: 'Off' } },
            { value: 'block', label: { 'zh-CN': '整体透视', en: 'Whole block' } },
            { value: 'glyph', label: { 'zh-CN': '逐字透视', en: 'Per glyph' } },
        ],
        'glyph',
    ),
    number(
        'pillarOpacity', GROUPS.course,
        { 'zh-CN': '柱子透明度', en: 'Pillar opacity' },
        { 'zh-CN': '柱子正面与顶面有多实（柱顶的字不吃这一档）。100% 是一整面实墙，压在译文上就真的挡住；调低就透出后面的画面与译文，柱子从「挡住译文的墙」变成压在字上的一层玻璃。**滑到 0 就整面消失**，只剩棱线勾出的轮廓。默认 80%——写字的这一面本来就该看得见背后的东西。', en: 'How solid the front and top faces read (the words on top are unaffected). 100% is a solid wall that really does hide the translation; lower lets the frame and the type show through, so a pillar becomes a pane of glass. **At 0 the face is gone**, leaving only the outline the edges draw. Default 80% — the writing face is meant to let the scene behind it through.' },
        0, 1, 0.05, 0.8,
    ),
    number(
        'pillarSideOpacity', GROUPS.course,
        { 'zh-CN': '侧面填充透明度', en: 'Side fill opacity' },
        { 'zh-CN': '柱子侧面（端头那面墙，也含歇脚圆柱的右半边）的填充有多实。侧面本来就比正面淡一档，单独给一根滑杆，是因为两根拴在一起时正面调淡、侧壁就先没影了，柱子看着像缺了一面。默认 80%（跟着正面走）；拧到 100% 侧面和正面一样实，**拧到 0 侧壁整个消失**，只剩一条棱。', en: 'How solid the side faces read (the end wall, plus the right half of a rest cylinder). The side is a notch lighter than the front by design; it gets its own slider because when the two were tied together, thinning the front made the sidewalls vanish first and the block looked like it was missing a wall. Default 80% (tracks the front); at 100% the side matches the front, **at 0 the sidewall is gone** and only the edge is left.' },
        0, 1, 0.05, 0.8,
    ),
    number(
        'pillarEdgeOpacity', GROUPS.course,
        { 'zh-CN': '棱线透明度', en: 'Edge opacity' },
        { 'zh-CN': '柱子轮廓那圈描边有多实。以前它跟着正面一起算，于是「柱子透明度」拉到 100% 也只是面变实、边仍旧半透明，整根柱子看着还是薄薄一层、盖不住译文。现在它自己一档：想要实心柱子就把这两根都推到头；**拉到 0 连轮廓一起消失**，柱子上只剩字。默认 80%。', en: 'How solid the outlines around the blocks read. This used to ride on the front-face value, so even at 100% pillar opacity the faces went solid while the edges stayed translucent and the block still read as a thin film that could not hide the translation. It now has its own slider: for a truly solid block, push both this and the face value to the top; **at 0 the outline goes too** and only the words are left. Default 80%.' },
        0, 1, 0.05, 0.8,
    ),
    number(
        'otherRowOpacity', GROUPS.course,
        { 'zh-CN': '其他行浓淡', en: 'Other rows' },
        { 'zh-CN': '正在写的那一行是主角，上下两行（已经唱完的、等着接的）按这一档淡下去。100% 与当前行一模一样——三行完全同色，画面像一整片台阶；默认 90% 只把上下两行压淡一点点——台阶仍是整片铺开的样子，正在跳的那一行又高出一档；调小就一直退到只剩当前行。它乘在上面三根透明度之上，所以「柱子调实、其他行仍旧分得开」也是这一根说了算。', en: 'The row being sung is the lead; the row just finished and the row waiting above fade by this much. 100% makes all three rows identical — the frame reads as one continuous staircase; 90% by default only dips the other two, so the staircase still reads as one surface while the hopping row stands out a notch; lower fades them away until only the current row is left. It multiplies the three opacity sliders above, so "solid pillars that still separate the rows" is this knob’s call.' },
        0, 1, 0.05, 0.9,
    ),
    number(
        'translationGlow', GROUPS.translation,
        { 'zh-CN': '译文辉光', en: 'Translation glow' },
        { 'zh-CN': '字周围那圈光：取主题的强调色，按这块字的外轮廓晕开一圈（不是背后垫一块底）。0 = 不发光，只留细描边；越大光越亮、晕得越开。深色画面里字会像自己亮着。', en: 'A halo around the letters in the theme’s accent colour, following the block’s outline (not a plate behind it). 0 leaves just the thin outline; higher makes it brighter and wider, so the words seem to light themselves on a dark frame.' },
        0, 1, 0.05, 0.28,
    ),
    number(
        'flySeconds', GROUPS.motion,
        { 'zh-CN': '滞空时间', en: 'Air time' },
        { 'zh-CN': '一次跳跃在空里待几**秒**（不是比例）。唱得快时这一跳几乎占满整个拍子，唱得慢时跳完就站着等下一句——快歌慢歌里「跳这一下」本身一样快。', en: 'How many **seconds** one hop stays in the air (not a share). On fast lyrics the hop fills almost the whole beat; on slow ones it lands and waits — the hop itself keeps the same speed either way.' },
        0.1, 1.2, 0.05, 0.45,
    ),
    number(
        'runnerScale', GROUPS.motion,
        { 'zh-CN': '小人尺寸', en: 'Runner size' },
        { 'zh-CN': '小人有多高（倍，相对他自己的基准身高）。跳一跳里人是主角：默认 1.2，比一根柱子还高一头；拧到最小就只剩一个小棋子。头顶的地方是算进画面预算的，拧大只会让整屏的柱子让出一点空间，人不会顶出画面。', en: 'How tall the runner stands, as a multiple of his base height. In hopscotch the runner is the star: 1.2 by default, a head taller than a pillar; turn it down and he shrinks to a small piece. The room above his head is part of the frame budget, so raising this only gives the pillars a little less room — he never pokes out of the frame.' },
        0.2, 2, 0.05, 1.2,
    ),
    number(
        'arc', GROUPS.motion,
        { 'zh-CN': '跳跃高度', en: 'Hop arc' },
        { 'zh-CN': '跳跃高度（格）：腾空那一段抬多高。默认 1.2，约半根柱子——看得清是跳过去的，又不会像飞。0 是贴地滑过去。', en: 'How high the runner leaps, in cells: how far the arc lifts him. Default 1.2, about half a pillar — clearly a hop, not a flight. 0 slides along the ground.' },
        0, 2.4, 0.05, 1.2,
    ),
    number(
        'trail', GROUPS.look,
        { 'zh-CN': '跳跃轨迹', en: 'Hop trail' },
        { 'zh-CN': '跳过的地方留多清楚的虚线；落地那一瞬在柱顶铺开的冲击环与飞尘也跟着它一起浓淡。0 只留灰疙瘩。刚跳过的那一跳最实，往后随时间淡下去——淡多久跟着这一行的节奏走，唱得快淡得快。', en: 'How visible the trail of past hops is; the impact ring and dust that burst on the pillar top at each landing follow it too. 0 leaves only fading dots. The hop just made is the brightest and older ones fade away — the fade follows this line’s pace, quicker when the singing is quick.' },
        0, 1, 0.05, 0.5,
    ),
];

/** 缺省值的一份快照：主机没给值（或给了非法值）时按它回落。 */
export const JUMP_DEFAULT_KNOBS = Object.freeze(
    Object.fromEntries(JUMP_SETTINGS_SCHEMA.map((param) => [param.key, param.defaultValue])),
);
