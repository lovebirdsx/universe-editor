// vscode-compat-template.js — 移植模板：把 VSCode 插件迁入 Universe Editor 时，
// 提供一个 `vscode` 形状的兼容层，底层由 @universe-editor/extension-api 支撑，
// 让移植过来的源码（原本面向 VSCode API 编写）尽量保持原结构。
//
// 用法：复制本文件到目标扩展的 src/（如 src/vscode_compat.js），按 `TODO(port):`
// 标记填充目标扩展专属内容（配置段名/键/默认值、状态栏 codicon 映射等），
// 其余部分通常无需改动。所有 TODO(port): 都必须在移植时处理，否则会构建失败或
// 运行踩坑。移植前请先读 port-vscode-extension/SKILL.md 的「宿主已知陷阱清单」。
//
// 设计要点：
// - Position/Range/Selection 按 LSP 形状（{line, character} start/end）构造，
//   可直接传给 Universe API，无需转换。
// - 宿主 TextDocument 句柄很薄（uri/languageId/version/isUntitled/getText），
//   wrapDoc() 补齐移植代码依赖的 lineAt/lineCount/fileName/validateRange，
//   并带 per-version 行缓存。
// - workspace.getConfiguration().get() 在 Universe 是异步（renderer 侧配置），
//   这里用「预取的扩展自身配置缓存」让移植调用点保持同步，每次
//   onDidChangeConfiguration 刷新（见 makeSyncConfiguration）。
// - window.activeTextEditor 不存在（只有异步 getActiveTextEditor）；移植的
//   extension.js 需要 await 它——这里不做同步模拟。冷启动拿到 undefined 时订阅
//   onDidOpenTextDocument / onDidChangeActiveTextEditor 再取（见 SKILL.md 陷阱清单）。

import {
    commands as u_commands,
    window as u_window,
    workspace as u_workspace,
    languages as u_languages,
    env as u_env,
    Uri,
    ThemeColor,
    StatusBarAlignment,
    ProgressLocation,
} from '@universe-editor/extension-api';

// ---------------------------------------------------------------------------
// Basic classes (LSP-shaped, structurally compatible with host API params).
// ---------------------------------------------------------------------------

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
    compareTo(other) {
        if (this.line != other.line)
            return this.line < other.line ? -1 : 1;
        if (this.character != other.character)
            return this.character < other.character ? -1 : 1;
        return 0;
    }
    isEqual(other) {
        return this.compareTo(other) == 0;
    }
    isBefore(other) {
        return this.compareTo(other) < 0;
    }
    isBeforeOrEqual(other) {
        return this.compareTo(other) <= 0;
    }
    isAfter(other) {
        return this.compareTo(other) > 0;
    }
    isAfterOrEqual(other) {
        return this.compareTo(other) >= 0;
    }
    translate(lineDelta = 0, characterDelta = 0) {
        return new Position(this.line + lineDelta, this.character + characterDelta);
    }
    with(line = this.line, character = this.character) {
        return new Position(line, character);
    }
}

function pos_less_or_equal(a, b) {
    return a.line < b.line || (a.line == b.line && a.character <= b.character);
}

class Range {
    constructor(a, b, c, d) {
        if (typeof a === 'number') {
            this.start = new Position(a, b);
            this.end = new Position(c, d);
        } else {
            this.start = new Position(a.line, a.character);
            this.end = new Position(b.line, b.character);
        }
    }
    // VSCode semantics: contains() treats ranges as closed [] intervals.
    contains(range_or_position) {
        if (range_or_position instanceof Range || (range_or_position.start && range_or_position.end)) {
            return pos_less_or_equal(this.start, range_or_position.start) && pos_less_or_equal(range_or_position.end, this.end);
        }
        return pos_less_or_equal(this.start, range_or_position) && pos_less_or_equal(range_or_position, this.end);
    }
    get isEmpty() {
        return this.start.line == this.end.line && this.start.character == this.end.character;
    }
}

class Selection extends Range {
    constructor(anchor, active) {
        super(pos_less_or_equal(anchor, active) ? anchor : active, pos_less_or_equal(anchor, active) ? active : anchor);
        this.anchor = new Position(anchor.line, anchor.character);
        this.active = new Position(active.line, active.character);
    }
}

class InlayHint {
    constructor(position, label) {
        this.position = position;
        this.label = label;
    }
}

class MarkdownString {
    constructor(value = '') {
        this.value = value;
        this.__plaintext = true;
    }
    appendText(text) {
        this.value += text;
        return this;
    }
    appendMarkdown(text) {
        this.value += text;
        this.__plaintext = false;
        return this;
    }
}

class Hover {
    constructor(contents) {
        this.contents = contents;
    }
}

class DocumentSymbol {
    constructor(name, detail, kind, range, selectionRange) {
        this.name = name;
        this.detail = detail;
        this.kind = kind;
        this.range = range;
        this.selectionRange = selectionRange;
        this.children = [];
    }
}

class SemanticTokensLegend {
    constructor(tokenTypes, tokenModifiers = []) {
        this.tokenTypes = tokenTypes;
        this.tokenModifiers = tokenModifiers;
    }
}

// Hand-written replacement for vscode.SemanticTokensBuilder: collects (range, type)
// pairs and emits the LSP delta-encoded uint array. Ranges pushed by the ported
// tokenizers must be single-line (multiline fields should be pre-split upstream).
class SemanticTokensBuilder {
    constructor(legend) {
        this.legend = legend;
        this.entries = [];
    }
    push(range, token_type_name) {
        let type_index = this.legend.tokenTypes.indexOf(token_type_name);
        if (type_index == -1) {
            return;
        }
        let length = range.end.character - range.start.character;
        if (length <= 0) {
            return;
        }
        this.entries.push([range.start.line, range.start.character, length, type_index]);
    }
    build() {
        this.entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let data = [];
        let prev_line = 0;
        let prev_char = 0;
        for (let [line, char, length, type_index] of this.entries) {
            let delta_line = line - prev_line;
            let delta_char = delta_line == 0 ? char - prev_char : char;
            data.push(delta_line, delta_char, length, type_index, /*modifiers=*/0);
            prev_line = line;
            prev_char = char;
        }
        return { data: data };
    }
}

// Enums mirrored from VSCode (values match LSP / VSCode where it matters).
// SymbolKind is a minimal subset — add the members the ported code actually uses.
const SymbolKind = { File: 1, Class: 5 };
const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

const FAKE_CANCELLATION_TOKEN = { isCancellationRequested: false };

// ---------------------------------------------------------------------------
// TextDocument wrapper: thin host doc -> VSCode-shaped doc.
// ---------------------------------------------------------------------------

const doc_wrapper_cache = new WeakMap();

function split_lines(text) {
    return text.split(/\r\n|\r|\n/);
}

function wrapDoc(raw_doc) {
    if (!raw_doc) {
        return raw_doc;
    }
    if (doc_wrapper_cache.has(raw_doc)) {
        return doc_wrapper_cache.get(raw_doc);
    }
    let lines_cache = { version: -1, lines: null };
    function get_lines() {
        if (lines_cache.version !== raw_doc.version) {
            lines_cache.lines = split_lines(raw_doc.getText());
            lines_cache.version = raw_doc.version;
        }
        return lines_cache.lines;
    }
    const uri = Uri.from(raw_doc.uri);
    const wrapper = {
        __raw: raw_doc,
        uri: uri,
        get languageId() { return raw_doc.languageId; },
        get version() { return raw_doc.version; },
        get isUntitled() { return raw_doc.isUntitled; },
        // TODO(port): Universe 不在镜像文档上做 dirty 跟踪，这里固定 false。
        // 移植代码里依赖 isDirty 的「未保存更改」守卫会因此退化为空操作——
        // 若目标扩展依赖该守卫，需改为显式跟踪用户是否发起过编辑（在
        // onDidChangeTextDocument 里置位）。
        get isDirty() { return false; },
        get fileName() {
            if (uri.scheme === 'file') {
                return uri.fsPath;
            }
            // untitled docs: VSCode uses "Untitled-1"-style names; the path is the
            // closest stable identifier Universe gives us.
            return uri.path || uri.toString();
        },
        getText() { return raw_doc.getText(); },
        get lineCount() { return get_lines().length; },
        lineAt(line_num) {
            let lines = get_lines();
            let text = line_num >= 0 && line_num < lines.length ? lines[line_num] : '';
            return { text: text, lineNumber: line_num };
        },
        validateRange(range) {
            let lines = get_lines();
            let max_line = Math.max(0, lines.length - 1);
            let start_line = Math.min(Math.max(range.start.line, 0), max_line);
            let end_line = Math.min(Math.max(range.end.line, 0), max_line);
            let start_char = Math.min(range.start.character, lines[start_line].length);
            let end_char = Math.min(range.end.character, lines[end_line].length);
            return new Range(start_line, start_char, end_line, end_char);
        },
    };
    doc_wrapper_cache.set(raw_doc, wrapper);
    return wrapper;
}

function unwrapDoc(doc) {
    return doc && doc.__raw ? doc.__raw : doc;
}

// ---------------------------------------------------------------------------
// TextEditor wrapper.
// ---------------------------------------------------------------------------

// Last range requested from our range-based providers, per document fileName.
// Stands in for editor.visibleRanges which Universe does not expose.
const last_provider_ranges = new Map();

function record_provider_range(doc_wrapper, range) {
    try {
        last_provider_ranges.set(doc_wrapper.fileName, range);
    } catch (_e) { /* fileName can throw only on exotic uris; ignore */ }
}

function get_last_provider_range(doc_wrapper) {
    return last_provider_ranges.get(doc_wrapper.fileName) || null;
}

function to_host_selection(sel) {
    return { anchor: { line: sel.anchor.line, character: sel.anchor.character }, active: { line: sel.active.line, character: sel.active.character } };
}

function from_host_selection(sel) {
    return new Selection(new Position(sel.anchor.line, sel.anchor.character), new Position(sel.active.line, sel.active.character));
}

function wrapEditor(raw_editor) {
    if (!raw_editor) {
        return raw_editor;
    }
    const doc_wrapper = wrapDoc(raw_editor.document);
    return {
        __raw: raw_editor,
        document: doc_wrapper,
        get selections() { return (raw_editor.selections || []).map(from_host_selection); },
        set selections(new_selections) {
            void raw_editor.setSelections(new_selections.map(to_host_selection));
        },
        get selection() { return raw_editor.selection ? from_host_selection(raw_editor.selection) : undefined; },
        set selection(new_selection) {
            void raw_editor.setSelections([to_host_selection(new_selection)]);
        },
        edit(callback) {
            return raw_editor.edit(callback);
        },
        setDecorations(decoration_type, ranges) {
            raw_editor.setDecorations(decoration_type, ranges);
        },
        // Universe setSelections reveals the primary selection already.
        revealRange(_range, _reveal_type) {},
        get visibleRanges() {
            let last_range = get_last_provider_range(doc_wrapper);
            if (last_range) {
                return [last_range];
            }
            // TODO(port): 兜底为「前 N 行」。原实现写死前 100 行；按目标扩展
            // 需要调整 N（或换成空数组/整文档范围）。
            let end_line = Math.min(doc_wrapper.lineCount - 1, 100);
            return [new Range(0, 0, Math.max(end_line, 0), 0)];
        },
        // TODO(port): tabSize 控制宿主未暴露，这里是无害 no-op。原实现写死 4；
        // 若目标扩展读取 tabSize 做缩进计算，改成目标扩展期望的常量。
        options: { get tabSize() { return 4; }, set tabSize(_v) {} },
    };
}

// ---------------------------------------------------------------------------
// Configuration cache: keeps get_from_config() synchronous.
// ---------------------------------------------------------------------------

// TODO(port): 换成目标扩展的配置段名与键/默认值。示例取自 rainbow_csv。
const CONFIG_SECTION = 'TODO(port): your extension id, e.g. "rainbow_csv"';
const CONFIG_KEYS = [
    // TODO(port): 列出目标扩展 configuration 里所有键。
    'enable_sticky_header', 'enable_debug_logging',
];
const CONFIG_DEFAULTS = {
    // TODO(port): 每个键的默认值，与 package.json contributes.configuration 对齐。
    enable_sticky_header: true, enable_debug_logging: false,
};

let config_cache = new Map();

export async function refreshConfigCache() {
    const host_config = u_workspace.getConfiguration(CONFIG_SECTION);
    const entries = await Promise.all(CONFIG_KEYS.map(async (key) => {
        try {
            return [key, await host_config.get(key, CONFIG_DEFAULTS[key])];
        } catch (_e) {
            return [key, CONFIG_DEFAULTS[key]];
        }
    }));
    config_cache = new Map(entries);
}

function makeSyncConfiguration(section) {
    if (section === CONFIG_SECTION) {
        return {
            get(key, default_value) {
                if (config_cache.has(key)) {
                    let value = config_cache.get(key);
                    return value === undefined || value === null ? (default_value !== undefined ? default_value : CONFIG_DEFAULTS[key]) : value;
                }
                return default_value !== undefined ? default_value : CONFIG_DEFAULTS[key];
            },
            update(key, value) {
                config_cache.set(key, value);
                return u_workspace.getConfiguration(CONFIG_SECTION).update(key, value);
            },
        };
    }
    // Other sections (e.g. 'editor'): reads return undefined — the ported code
    // only touches these inside VSCode-specific workarounds that were stubbed out.
    return { get(_key, default_value) { return default_value; }, update(_key, _value) { return Promise.resolve(); } };
}

// ---------------------------------------------------------------------------
// StatusBarItem / OutputChannel wrappers.
// ---------------------------------------------------------------------------

// TODO(port): 仅当宿主不支持 codicon 时作为文本 glyph 降级。当前宿主状态栏
// （StatusBar.tsx）已原生支持 $(icon) 语法，通常不需要此替换——把映射留空并
// 让 wrapStatusBarItem 直接透传即可。
const CODICON_SUBSTITUTES = { /* TODO(port): e.g. clock: '⏳', error: '✗' */ };

function substitute_codicons(text) {
    return text.replace(/\$\((\w[\w-]*)\)/g, (_m, name) => CODICON_SUBSTITUTES[name] || '');
}

function wrapStatusBarItem(raw_item) {
    let text_value = '';
    return {
        __raw: raw_item,
        get text() { return text_value; },
        set text(v) {
            text_value = v;
            // 宿主已原生支持 $(icon) 语法，直接透传即可；如需降级，改用
            // substitute_codicons(v) 并填充 CODICON_SUBSTITUTES。
            raw_item.text = v;
        },
        get tooltip() { return raw_item.tooltip; },
        set tooltip(v) { raw_item.tooltip = v; },
        get command() { return raw_item.command; },
        set command(v) { raw_item.command = v; },
        // 宿主状态栏无 color 支持；状态信息改用 codicon 或文本 glyph 传达。
        get color() { return undefined; },
        set color(_v) {},
        show() { raw_item.show(); },
        hide() { raw_item.hide(); },
        dispose() { raw_item.dispose(); },
    };
}

function wrapOutputChannel(raw_channel) {
    return {
        __raw: raw_channel,
        append(v) { raw_channel.append(v); },
        appendLine(v) { raw_channel.appendLine(v); },
        clear() { raw_channel.clear(); },
        show() { raw_channel.show(); },
        info(v) { raw_channel.appendLine(`[info] ${v}`); },
        warn(v) { raw_channel.appendLine(`[warn] ${v}`); },
        error(v) { raw_channel.appendLine(`[error] ${v}`); },
        dispose() { if (raw_channel.dispose) raw_channel.dispose(); },
    };
}

// ---------------------------------------------------------------------------
// Namespace facades.
// ---------------------------------------------------------------------------

function to_selector(vscode_selector) {
    // VSCode DocumentSelector objects ({language: id}) -> Universe string[].
    if (typeof vscode_selector === 'string') {
        return vscode_selector;
    }
    if (Array.isArray(vscode_selector)) {
        return vscode_selector.map((s) => (typeof s === 'string' ? s : s.language));
    }
    return vscode_selector.language;
}

const compat_window = {
    showErrorMessage: (...args) => u_window.showErrorMessage(...args),
    showWarningMessage: (...args) => u_window.showWarningMessage(...args),
    showInformationMessage: (...args) => u_window.showInformationMessage(...args),
    async showInputBox(options = {}) {
        const { validateInput, ...supported } = options;
        let result = await u_window.showInputBox(supported);
        if (result !== undefined && typeof validateInput === 'function') {
            let error = validateInput(result);
            if (error) {
                void u_window.showErrorMessage(String(error));
                return undefined;
            }
        }
        return result;
    },
    async showTextDocument(doc_or_target, options) {
        let target = unwrapDoc(doc_or_target);
        let raw_editor = await u_window.showTextDocument(target, options);
        return wrapEditor(raw_editor);
    },
    async getActiveTextEditor() {
        let raw_editor = await u_window.getActiveTextEditor();
        return raw_editor ? wrapEditor(raw_editor) : null;
    },
    createStatusBarItem(alignment, priority) {
        return wrapStatusBarItem(u_window.createStatusBarItem(alignment, priority));
    },
    createOutputChannel(name, _options) {
        return wrapOutputChannel(u_window.createOutputChannel(name));
    },
    createTextEditorDecorationType(options) {
        return u_window.createTextEditorDecorationType(options);
    },
    createWebviewPanel(view_type, title, _view_column, options = {}) {
        // ViewColumn is intentionally dropped: Universe panels open in the active group.
        return u_window.createWebviewPanel(view_type, title, {}, { enableScripts: !!options.enableScripts });
    },
    withProgress(options, task) {
        return u_window.withProgress(options, task);
    },
    onDidChangeTextEditorSelection(handler) {
        return u_window.onDidChangeTextEditorSelection((event) => handler({
            textEditor: wrapEditor(event.textEditor),
            selections: (event.selections || []).map(from_host_selection),
            kind: event.kind,
        }));
    },
    onDidChangeActiveTextEditor(handler) {
        return u_window.onDidChangeActiveTextEditor((raw_editor) => handler(raw_editor ? wrapEditor(raw_editor) : undefined));
    },
};

const compat_workspace = {
    // Mirrored open documents. On a cold start the first document's mirror can
    // land without any editor/document event - this list is the reliable way
    // to discover it (see WindowApi.visibleTextEditors docs in the d.ts).
    get textDocuments() {
        return (u_workspace.textDocuments || []).map(wrapDoc);
    },
    getConfiguration(section, _scope) {
        return makeSyncConfiguration(section);
    },
    async openTextDocument(target) {
        let raw_doc = await u_workspace.openTextDocument(target);
        return wrapDoc(raw_doc);
    },
    onDidOpenTextDocument(handler) {
        return u_workspace.onDidOpenTextDocument((raw_doc) => handler(wrapDoc(raw_doc)));
    },
    onDidCloseTextDocument(handler) {
        return u_workspace.onDidCloseTextDocument((raw_doc) => handler(wrapDoc(raw_doc)));
    },
    onDidChangeTextDocument(handler) {
        return u_workspace.onDidChangeTextDocument((event) => handler({
            document: wrapDoc(event.document),
            contentChanges: event.contentChanges,
        }));
    },
    onDidChangeConfiguration(handler) {
        return u_workspace.onDidChangeConfiguration(async (event) => {
            await refreshConfigCache();
            handler(event);
        });
    },
};

const compat_languages = {
    registerHoverProvider(selector, provider) {
        return u_languages.registerHoverProvider(to_selector(selector), {
            async provideHover(raw_doc, position) {
                let hover = await provider.provideHover(wrapDoc(raw_doc), new Position(position.line, position.character), FAKE_CANCELLATION_TOKEN);
                if (!hover) {
                    return hover;
                }
                let contents = hover.contents;
                let value = typeof contents === 'string' ? contents : contents.value;
                let kind = (contents && contents.__plaintext === false) ? 'markdown' : 'plaintext';
                return { contents: { kind: kind, value: value } };
            },
        });
    },
    registerDocumentSymbolProvider(selector, provider) {
        return u_languages.registerDocumentSymbolProvider(to_selector(selector), {
            async provideDocumentSymbols(raw_doc) {
                let symbols = await provider.provideDocumentSymbols(wrapDoc(raw_doc));
                if (!symbols) {
                    return symbols;
                }
                return symbols.map((s) => ({
                    name: s.name,
                    detail: s.detail || '',
                    kind: s.kind,
                    range: s.range,
                    selectionRange: s.selectionRange,
                    children: s.children || [],
                }));
            },
        });
    },
    registerInlayHintsProvider(selector, provider) {
        return u_languages.registerInlayHintsProvider(to_selector(selector), {
            async provideInlayHints(raw_doc, range) {
                let doc_wrapper = wrapDoc(raw_doc);
                let compat_range = new Range(range.start, range.end);
                record_provider_range(doc_wrapper, compat_range);
                return provider.provideInlayHints(doc_wrapper, compat_range, FAKE_CANCELLATION_TOKEN);
            },
        });
    },
    registerDocumentRangeSemanticTokensProvider(selector, provider, legend) {
        return u_languages.registerDocumentRangeSemanticTokensProvider(to_selector(selector), {
            legend: { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers || [] },
            async provideDocumentRangeSemanticTokens(raw_doc, range) {
                let doc_wrapper = wrapDoc(raw_doc);
                let compat_range = new Range(range.start, range.end);
                record_provider_range(doc_wrapper, compat_range);
                return provider.provideDocumentRangeSemanticTokens(doc_wrapper, compat_range, FAKE_CANCELLATION_TOKEN);
            },
        });
    },
    async setTextDocumentLanguage(doc, language_id) {
        let new_raw_doc = await u_languages.setTextDocumentLanguage(unwrapDoc(doc), language_id);
        return wrapDoc(new_raw_doc);
    },
    setLanguageConfiguration(language_id, configuration) {
        return u_languages.setLanguageConfiguration(language_id, configuration);
    },
};

// ---------------------------------------------------------------------------
// The vscode-shaped facade consumed by the ported sources.
// ---------------------------------------------------------------------------

const vscode = {
    window: compat_window,
    workspace: compat_workspace,
    languages: compat_languages,
    commands: {
        registerCommand: (id, handler) => u_commands.registerCommand(id, handler),
        executeCommand: (...args) => u_commands.executeCommand(...args),
    },
    env: u_env,
    Uri,
    ThemeColor,
    StatusBarAlignment,
    ProgressLocation,
    Position,
    Range,
    Selection,
    InlayHint,
    MarkdownString,
    Hover,
    DocumentSymbol,
    SemanticTokensLegend,
    SemanticTokensBuilder,
    SymbolKind,
    TextEditorRevealType,
    ViewColumn,
};

export default vscode;
export { wrapDoc, unwrapDoc, wrapEditor };
