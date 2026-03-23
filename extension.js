const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/** 「所有语言」的特殊标识值 */
const ALL_LOCALES = '*';

/**
 * 将完整 key 拆分为 namespace（文件名）和 JSON 内部路径
 */
function splitNamespaceAndKey(fullKey, localesDir) {
    const parts = fullKey.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
        const candidateNs = parts.slice(0, i).join('.');
        const candidateFile = path.join(localesDir, `${candidateNs}.json`);
        if (fs.existsSync(candidateFile)) {
            return { namespace: candidateNs, keyPath: parts.slice(i), filePath: candidateFile };
        }
    }
    return null;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 统计一行中不在 JSON 字符串值内的花括号数量。
 * 对于标准格式化的 JSON（每行一个 key-value），这足够准确。
 */
function countBraces(line) {
    let open = 0, close = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') open++;
        else if (ch === '}') close++;
    }
    return { open, close };
}

/**
 * 在 JSON 文件中逐层查找嵌套 key，通过花括号追踪深度来精确匹配层级
 */
function findKeyPosition(jsonFilePath, keyPath) {
    const content = fs.readFileSync(jsonFilePath, 'utf-8');
    const lines = content.split('\n');

    let depth = 0;
    let pathIndex = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (pathIndex < keyPath.length) {
            const searchKey = keyPath[pathIndex];
            const expectedDepth = pathIndex + 1;
            const keyPattern = new RegExp(`"${escapeRegex(searchKey)}"\\s*:`);

            if (depth === expectedDepth && keyPattern.test(line)) {
                if (pathIndex === keyPath.length - 1) {
                    const col = line.indexOf(`"${searchKey}"`);
                    return { line: i, character: Math.max(col, 0) };
                }
                pathIndex++;
            }
        }

        const braces = countBraces(line);
        depth += braces.open - braces.close;
    }
    return null;
}

/**
 * 带回退的 key 查找：如果完整 keyPath 找不到，逐级去掉末尾层级再查找，
 * 直到找到最近的已定义层级。
 * 例如 keyPath=['usual','scan','weightStartSuccess']，
 * weightStartSuccess 找不到 → 回退到 scan → 再回退到 usual
 */
function findKeyPositionWithFallback(jsonFilePath, keyPath) {
    for (let len = keyPath.length; len >= 1; len--) {
        const subPath = keyPath.slice(0, len);
        const pos = findKeyPosition(jsonFilePath, subPath);
        if (pos) {
            return { ...pos, fallback: len < keyPath.length };
        }
    }
    return null;
}

/**
 * 从一行文本中提取所有 i18n 调用的 key 及其在行内的范围
 */
function extractAllKeysFromLine(lineText) {
    const results = [];
    const patterns = [
        /\$t\(\s*['"`]([^'"`]+)['"`]/g,
        /\btt?\(\s*['"`]([^'"`]+)['"`]/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(lineText)) !== null) {
            const keyStart = match.index + match[0].indexOf(match[1]);
            const keyEnd = keyStart + match[1].length;
            results.push({ key: match[1], keyStart, keyEnd });
        }
    }
    return results;
}

/**
 * 构建跳转 URI，带上行号和列号信息
 */
function buildTargetUri(filePath, line, character) {
    return vscode.Uri.file(filePath).with({
        fragment: `L${line + 1},${character + 1}`,
    });
}

/**
 * 读取插件配置，获取当前 locales 目录的绝对路径
 */
function getLocalesDir() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return null;

    const config = vscode.workspace.getConfiguration('i18nDefinitionJump');
    const localesPath = config.get('localesPath', 'src/i18n/locales');
    const targetLocale = config.get('targetLocale', 'zh-CN');

    return {
        localesDir: targetLocale === ALL_LOCALES ? null : path.join(workspaceFolder, localesPath, targetLocale),
        targetLocale,
        localesRoot: path.join(workspaceFolder, localesPath),
    };
}

/**
 * 扫描 locales 根目录下的所有语言文件夹名
 */
function scanAvailableLocales(localesRoot) {
    if (!fs.existsSync(localesRoot)) return [];
    return fs.readdirSync(localesRoot).filter((name) => {
        return fs.statSync(path.join(localesRoot, name)).isDirectory();
    });
}

/**
 * 为单个语言目录解析一个 key 的跳转目标，支持 key 回退
 */
function resolveKeyInLocale(key, localesDir, localeName) {
    const result = splitNamespaceAndKey(key, localesDir);
    if (!result) return null;

    const pos = findKeyPositionWithFallback(result.filePath, result.keyPath);
    return pos ? { filePath: result.filePath, pos, localeName } : null;
}

/** 状态栏按钮，显示当前目标语言 */
let statusBarItem;

function updateStatusBar(locale) {
    if (statusBarItem) {
        const label = locale === ALL_LOCALES ? '所有语言' : locale;
        statusBarItem.text = `$(globe) i18n: ${label}`;
        statusBarItem.tooltip = '点击切换 i18n 跳转目标语言';
    }
}

function activate(context) {
    const supportedLanguages = [
        { language: 'vue', scheme: 'file' },
        { language: 'typescript', scheme: 'file' },
        { language: 'javascript', scheme: 'file' },
        { language: 'typescriptreact', scheme: 'file' },
        { language: 'javascriptreact', scheme: 'file' },
    ];

    /** 用于通知 VSCode 重新请求 DocumentLink 的事件发射器 */
    const linkChangeEmitter = new vscode.EventEmitter();

    // 状态栏显示当前目标语言，点击可切换
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'i18nDefinitionJump.switchLocale';
    const currentLocale = vscode.workspace.getConfiguration('i18nDefinitionJump').get('targetLocale', 'zh-CN');
    updateStatusBar(currentLocale);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 注册切换语言命令：扫描 locales 目录，弹出快速选择列表（含「所有语言」选项）
    const switchLocaleCmd = vscode.commands.registerCommand('i18nDefinitionJump.switchLocale', async () => {
        const info = getLocalesDir();
        if (!info) {
            vscode.window.showWarningMessage('未检测到工作区');
            return;
        }

        const locales = scanAvailableLocales(info.localesRoot);
        if (locales.length === 0) {
            vscode.window.showWarningMessage(`未在 ${info.localesRoot} 下找到任何语言文件夹`);
            return;
        }

        const items = [
            {
                label: '$(globe) 所有语言',
                description: info.targetLocale === ALL_LOCALES ? '(当前)' : '',
                value: ALL_LOCALES,
            },
            ...locales.map((locale) => ({
                label: locale,
                description: locale === info.targetLocale ? '(当前)' : '',
                value: locale,
            })),
        ];

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: '选择跳转的目标语言',
        });

        if (picked) {
            const config = vscode.workspace.getConfiguration('i18nDefinitionJump');
            await config.update('targetLocale', picked.value, vscode.ConfigurationTarget.Workspace);
            updateStatusBar(picked.value);
            linkChangeEmitter.fire();
            const label = picked.value === ALL_LOCALES ? '所有语言' : picked.value;
            vscode.window.showInformationMessage(`i18n 跳转目标语言已切换为: ${label}`);
        }
    });

    /**
     * DocumentLinkProvider：单语言模式下，在 i18n key 上生成可点击的链接直接跳转
     * 「所有语言」模式下不生成 link，由 DefinitionProvider 接管
     */
    const linkProvider = vscode.languages.registerDocumentLinkProvider(
        supportedLanguages,
        {
            onDidChangeDocumentLinks: linkChangeEmitter.event,
            provideDocumentLinks(document) {
                const info = getLocalesDir();
                if (!info || info.targetLocale === ALL_LOCALES) return [];

                const localesDir = info.localesDir;
                const links = [];

                for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
                    const lineText = document.lineAt(lineIdx).text;
                    const keys = extractAllKeysFromLine(lineText);

                    for (const { key, keyStart, keyEnd } of keys) {
                        const resolved = resolveKeyInLocale(key, localesDir, info.targetLocale);
                        if (!resolved) continue;

                        const range = new vscode.Range(lineIdx, keyStart, lineIdx, keyEnd);
                        const targetUri = buildTargetUri(resolved.filePath, resolved.pos.line, resolved.pos.character);

                        const link = new vscode.DocumentLink(range, targetUri);
                        const fallbackHint = resolved.pos.fallback ? ' (回退匹配)' : '';
                        link.tooltip = `跳转到 [${info.targetLocale}] ${path.basename(resolved.filePath)} (第${resolved.pos.line + 1}行)${fallbackHint}`;
                        links.push(link);
                    }
                }
                return links;
            },
        }
    );

    /**
     * DefinitionProvider：「所有语言」模式下，Ctrl+Click 返回所有语言包中的定位，
     * VSCode 会以 peek 多结果视图展示
     */
    const defProvider = vscode.languages.registerDefinitionProvider(
        supportedLanguages,
        {
            provideDefinition(document, position) {
                const info = getLocalesDir();
                if (!info || info.targetLocale !== ALL_LOCALES) return null;

                const lineText = document.lineAt(position.line).text;
                const keys = extractAllKeysFromLine(lineText);

                const clickedKey = keys.find(
                    (k) => position.character >= k.keyStart && position.character <= k.keyEnd
                );
                if (!clickedKey) return null;

                const locales = scanAvailableLocales(info.localesRoot);
                const locations = [];

                for (const locale of locales) {
                    const localeDir = path.join(info.localesRoot, locale);
                    const resolved = resolveKeyInLocale(clickedKey.key, localeDir, locale);
                    if (!resolved) continue;

                    locations.push(
                        new vscode.Location(
                            vscode.Uri.file(resolved.filePath),
                            new vscode.Position(resolved.pos.line, resolved.pos.character)
                        )
                    );
                }

                return locations;
            },
        }
    );

    // 配置变更时刷新状态栏并重新生成链接
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('i18nDefinitionJump.targetLocale')) {
            const locale = vscode.workspace.getConfiguration('i18nDefinitionJump').get('targetLocale', 'zh-CN');
            updateStatusBar(locale);
            linkChangeEmitter.fire();
        }
    });

    context.subscriptions.push(switchLocaleCmd, linkProvider, defProvider, configWatcher, linkChangeEmitter);
}

function deactivate() {}

module.exports = { activate, deactivate };
