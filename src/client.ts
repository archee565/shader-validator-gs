import * as vscode from "vscode";
import * as cp from "child_process";
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
    createStdioOptions,
    createUriConverters,
    startServer
} from './wasm-wasi-lsp'; // Should import from @vscode/wasm-wasi-lsp, but version not based on last released wasm-wasi version
import { MountPointDescriptor, ProcessOptions, Wasm } from "@vscode/wasm-wasi/v1";
import {
    CloseAction,
    CloseHandlerResult,
    ConfigurationParams,
    ConfigurationRequest,
    DidChangeConfigurationNotification,
    DidChangeTextDocumentNotification,
    DidOpenTextDocumentNotification,
    ErrorAction,
    ErrorHandler,
    ErrorHandlerResult,
    LanguageClient,
    LanguageClientOptions,
    Message,
    Middleware,
    ProtocolNotificationType,
    ProvideDocumentSymbolsSignature,
    ProvideInlayHintsSignature,
    RequestType,
    ServerOptions,
    Trace,
    TransportKind
} from 'vscode-languageclient/node';
import { IncludeResolver, ShaderPreprocessor, PreprocessResult } from './include-preprocessor';
import { sidebar } from "./extension";

export enum ServerPlatform {
    windows,
    linux,
    wasi,
}

export enum ServerStatus {
    running,
    stopped,
    error,
}

export function isRunningOnWeb() : boolean {
    // Web environment is detected with no fallback on child process which is not supported there.
    return typeof cp.spawn !== 'function' || typeof process === 'undefined';
}

function getConfigurationAsString(): string {
    let config = vscode.workspace.getConfiguration("shader-validator-gs");
    const configObject : { [key: string]: any } = {};
    const clientSideIncludes = config.get<boolean>("clientSideIncludes");
    for (const [key, value] of Object.entries(config)) {
        // When client-side include processing is active, don't send include
        // paths to the server — the server's own include resolution would
        // insert #line directives that cause GL_GOOGLE errors.
        if (clientSideIncludes && key === "includes") {
            continue;
        }
        configObject[key] = value;
    }
    return JSON.stringify(configObject);
}

export function resolveVSCodeVariables(content: string) : string {
    return content.replace(/\$\{(.*?)\}/g, (_match: string, variable: string) : string => {
        // Solve these https://code.visualstudio.com/docs/reference/variables-reference
        if (variable.startsWith("env:")) {
            const substitution = process.env[variable.slice(4)];
            if (typeof substitution === "string") {
                return substitution;
            }
        }
        if (variable === "userHome") {
            return os.homedir();
        }
        if (variable === "workspaceFolder") {
            if (vscode.workspace.workspaceFolders) {
                // Pick first workspace and ignores others.
                return vscode.workspace.workspaceFolders[0].uri.fsPath;
            }
        }
        // All others variable are relative to currently opened file and will be a pain to implement so ignoring them for now.
        return "";
    });
}
function getChannelName(): string {
    return 'Shader language Server';
}

export class ServerVersion {
    path: vscode.Uri;
    cwd: vscode.Uri;
    version: string;
    platform: ServerPlatform;

    constructor(extensionUri: vscode.Uri) {
        this.platform = ServerVersion.getServerPlatform();
        let userServerPathAndVersion = ServerVersion.getUserServerPathAndVersion(this.platform);
        if (userServerPathAndVersion) {
            this.version = userServerPathAndVersion[1];
            this.path = ServerVersion.getPlatformBinaryUri(extensionUri, userServerPathAndVersion[0], this.platform);
            this.cwd = ServerVersion.getPlatformBinaryDirectoryPath(extensionUri, userServerPathAndVersion[0], this.platform);
            if (!this.isValidVersion()) {
                vscode.window.showWarningMessage(`${this.version} is not compatible with this extension (Expecting ${ServerVersion.getBundledVersion()}). Server may crash or behave weirdly.`);
            }
        } else {
            // Get bundled version as user
            console.info(`No server path found. Using bundled server.`);
            this.version = ServerVersion.getBundledVersion();
            this.path = ServerVersion.getPlatformBinaryUri(extensionUri, null, this.platform);
            this.cwd = ServerVersion.getPlatformBinaryDirectoryPath(extensionUri, null, this.platform);
        }
    }
    private static getUserServerPathAndVersion(platform: ServerPlatform) : [string, string] | null {
        if (platform === ServerPlatform.wasi) {
            return null; // Bundled wasi version
        } else {
            // Check configuration.
            let serverPath = vscode.workspace.getConfiguration("shader-validator-gs").get<string>("serverPath");
            if (serverPath && serverPath.length > 0) {
                let serverVersion = ServerVersion.getServerVersion(serverPath, platform);
                if (serverVersion) {
                    console.info(`shader-validator.serverPath found: ${serverPath}`);
                    return [serverPath, serverVersion];
                } else {
                    console.warn("shader-validator.serverPath not found.");
                }
            }
            // Check environment variables
            if (process.env.SHADER_LANGUAGE_SERVER_EXECUTABLE_PATH !== undefined) {
                let envPath = process.env.SHADER_LANGUAGE_SERVER_EXECUTABLE_PATH;
                let serverVersion = ServerVersion.getServerVersion(envPath, platform);
                if (serverVersion) {
                    console.info(`SHADER_LANGUAGE_SERVER_EXECUTABLE_PATH found: ${envPath}`);
                    return [envPath, serverVersion];
                } else {
                    console.warn("SHADER_LANGUAGE_SERVER_EXECUTABLE_PATH server path not found.");
                }
            }
            // Use bundled executables.
            console.info("No server path user settings found. Using bundled executable.");
            return null;
        }
    }
    static getBundledVersion() : string {
        return "shader-language-server v" + vscode.extensions.getExtension('antaalt.shader-validator-gs')!.packageJSON.server_version;
    }
    private static getServerVersion(serverPath: string | null, platform: ServerPlatform) : string | null {
        if (isRunningOnWeb() || platform === ServerPlatform.wasi || serverPath === null) {
            // Bundled version always used on the web as we cant access external folders.
            // For wasi, we need some runner to test version & we cant do this here. So ignore check.
            return this.getBundledVersion();
        } else {
            // Get the server version if using a custom server (if serverPath is not null)
            // If we are using the bundled server, we never reach this path. Good because its a bit heavy on startup.
            if (fs.existsSync(serverPath)) {
                const result = cp.execSync(serverPath + " --version");
                const version = result.toString("utf8").trim();
                return version;
            } else {
                return null;
            }
        }
    }
    private isValidVersion() {
        const requestedServerVersion = vscode.extensions.getExtension('antaalt.shader-validator-gs')!.packageJSON.server_version;
        const versionExpected = "shader-language-server v" + requestedServerVersion;
        return this.version === versionExpected;
    }
    static getPlatformBinaryDirectoryPath(extensionUri: vscode.Uri, serverPath: string | null, platform: ServerPlatform) : vscode.Uri {
        if (serverPath) {
            return vscode.Uri.file(path.dirname(serverPath));
        } else {
            // CI is handling the copy to bin folder to avoid storage of exe on git.
            // Should only support arm64 & x64
            switch (platform) {
            case ServerPlatform.windows:
                return vscode.Uri.joinPath(extensionUri, `bin/win32-${process.arch}/`);
            case ServerPlatform.linux:
                return vscode.Uri.joinPath(extensionUri, `bin/linux-${process.arch}`);
            case ServerPlatform.wasi:
                return vscode.Uri.joinPath(extensionUri, "bin/wasi/");
            }
        }
    }
    static getPlatformBinaryName(serverPath: string | null, platform: ServerPlatform) : string {
        if (serverPath) {
            return path.basename(serverPath);
        } else {
            switch (platform) {
                case ServerPlatform.windows:
                    return "shader-language-server.exe";
                case ServerPlatform.linux:
                    return "shader-language-server";
                case ServerPlatform.wasi:
                    return "shader-language-server.wasm";
            }
        }
    }
    // Absolute path as uri
    static getPlatformBinaryUri(extensionUri: vscode.Uri, serverPath: string | null, platform: ServerPlatform) : vscode.Uri {
        return vscode.Uri.joinPath(ServerVersion.getPlatformBinaryDirectoryPath(extensionUri, serverPath, platform), ServerVersion.getPlatformBinaryName(serverPath, platform));
    }
    static getServerPlatform() : ServerPlatform {
        let useWasiServer = vscode.workspace.getConfiguration("shader-validator-gs").get<boolean>("useWasiServer")!;
        if (isRunningOnWeb() || useWasiServer) {
            return ServerPlatform.wasi;
        } else {
            // Dxc only built for linux x64 & windows x64 & arm. Fallback to WASI for every other situations.
            switch (process.platform) {
                case "win32":
                    return (process.arch === 'x64' || process.arch === 'arm64') ? ServerPlatform.windows : ServerPlatform.wasi;
                case "linux":
                    return (process.arch === 'x64') ? ServerPlatform.linux : ServerPlatform.wasi;
                default:
                    return ServerPlatform.wasi;
            }
        }
    }
};


class ShaderErrorHandler implements ErrorHandler {
    private server: ShaderLanguageClient;
    constructor(server: ShaderLanguageClient) {
        this.server = server;
    }
    public error(_error: Error, _message: Message, count: number): ErrorHandlerResult {
        this.server.updateStatus(ServerStatus.error);
        return { action: ErrorAction.Shutdown };
    }
    public closed(): CloseHandlerResult {
        this.server.updateStatus(ServerStatus.error);
        return { action: CloseAction.DoNotRestart, message: `The shader language server crashed. Set shader-validator.trace.server to messages or verbose for more information.` }; 
    }
}

export class ShaderLanguageClient {
    private client: LanguageClient | null = null;
    private channel: vscode.OutputChannel | null = null;
    private errorHandler: ShaderErrorHandler;
    private serverVersion: ServerVersion;
    private serverStatus: ServerStatus = ServerStatus.stopped;
    private statusChangedCallback: (status: ServerStatus) => void;
    private includeResolver: IncludeResolver;
    private preprocessor: ShaderPreprocessor;
    private preprocessResults: Map<string, PreprocessResult> = new Map();
    private preprocessTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private includeDiagCollection: vscode.DiagnosticCollection | null = null;
    private clientRef: { current: LanguageClient | null } = { current: null };

    constructor(context: vscode.ExtensionContext) {
        this.statusChangedCallback = (status) => {};
        this.serverVersion = new ServerVersion(context.extensionUri);
        this.errorHandler = new ShaderErrorHandler(this);
        this.includeResolver = new IncludeResolver();
        this.preprocessor = new ShaderPreprocessor(this.includeResolver);
        this.includeDiagCollection = vscode.languages.createDiagnosticCollection('shader-validator-includes');
        this.initIncludeDirs();
    }

    private initIncludeDirs(): void {
        const dirs = vscode.workspace.getConfiguration("shader-validator-gs")
            .get<string[]>("includes", [])
            .map(d => resolveVSCodeVariables(d));
        this.includeResolver.updateIncludeDirs(dirs);
        // Debug marker to verify new code is loaded
        try { fs.writeFileSync('/tmp/shader-validator-debug.txt', 'loaded\n'); } catch {}
    }

    onStatusChanged(statusChangedCallback: (status: ServerStatus) => void) {
        this.statusChangedCallback = statusChangedCallback;
    }

    async start(context: vscode.ExtensionContext, updateServerUsed: boolean): Promise<ServerStatus> {
        if (this.serverStatus === ServerStatus.running) {
            return ServerStatus.running;
        }
        let levelString = vscode.workspace.getConfiguration("shader-validator-gs").get<string>("trace.server")!;
        let level = Trace.fromString(levelString);
        switch (level) {
            case Trace.Verbose:
            case Trace.Compact:
            case Trace.Messages:
                this.channel = vscode.window.createOutputChannel(getChannelName());
                // Make logs display conveniently when in debug.
                if (context.extensionMode === vscode.ExtensionMode.Development) {
                    this.channel.show();
                }
                break;
            case Trace.Off:
                this.channel = null;
                break;
        }
        if (updateServerUsed) {
            this.updateServerVersion(context.extensionUri);
        }
        this.client = await this.createLanguageClient(context);
        this.serverStatus = this.client !== null ? ServerStatus.running : ServerStatus.error;
        return this.serverStatus;
    }
    async restart(context: vscode.ExtensionContext) {
        await this.stop();
        await this.start(context, true);
    }
    async stop() {
        for (const timer of this.preprocessTimers.values()) {
            clearTimeout(timer);
        }
        this.preprocessTimers.clear();
        this.preprocessResults.clear();
        await this.client?.stop(100).catch(_ => {});
        this.dispose();
        this.serverStatus = ServerStatus.stopped;
    }
    updateServerVersion(extensionUri: vscode.Uri) {
        this.serverVersion = new ServerVersion(extensionUri);
    }
    updateStatus(status: ServerStatus) {
        this.serverStatus = status;
        this.statusChangedCallback(status);
    }
    invalidateIncludeCache(uri: vscode.Uri): void {
        this.preprocessor.invalidateForFile(uri);
    }
    getServerStatus(): ServerStatus {
        return this.serverStatus;
    }
    getServerPath(): vscode.Uri {
        return this.serverVersion.path;
    }
    getServerVersion(): string {
        return this.serverVersion.version;
    }
    showLogs() {
        if (this.channel) {
            this.channel.show(false);
        }
    }
    dispose() {
        this.client?.dispose(100).catch(_ => {});
        this.channel?.dispose();
        this.includeDiagCollection?.dispose();
    }
    sendNotification<P, RO>(type: ProtocolNotificationType<P, RO>, params?: P): Promise<void> {
        return this.client!.sendNotification(type, params);
    }
    sendRequest<P, R, E>(type: RequestType<P, R, E>, params: P): Promise<R> {
        return this.client!.sendRequest(type, params);
    }
    uriAsString(uri: vscode.Uri): string {
        return this.client!.code2ProtocolConverter.asUri(uri);
    }
    stringAsUri(str: string): vscode.Uri {
        return this.client!.protocol2CodeConverter.asUri(str);
    }
    log(message: string) {
        if (this.channel) {
            this.channel.appendLine(message);
        }
    }
    static getSupportedLangId() {
        return ["hlsl", "glsl", "wgsl"];
    }
    static isEnabledLangId(langId: string) {
        let hlslSupported = vscode.workspace.getConfiguration("shader-validator-gs").get<boolean>("hlsl.enabled")!;
        let glslSupported = vscode.workspace.getConfiguration("shader-validator-gs").get<boolean>("glsl.enabled")!;
        let wgslSupported = vscode.workspace.getConfiguration("shader-validator-gs").get<boolean>("wgsl.enabled")!;
        switch(langId) {
            case "hlsl": return hlslSupported;
            case "glsl": return glslSupported;
            case "wgsl": return wgslSupported;
            default: return false;
        }
    }
    static getTraceLevel(): Trace {
        let levelString = vscode.workspace.getConfiguration("shader-validator-gs").get<string>("trace.server")!;
        return Trace.fromString(levelString);
    }

    private async createLanguageClient(context: vscode.ExtensionContext): Promise<LanguageClient | null> {
        // Create validator
        // Web does not support child process, use wasi instead.
        if (this.serverVersion.platform === ServerPlatform.wasi) {
            return this.createLanguageClientWASI(context);
        } else {
            return this.createLanguageClientStandard(context);
        }
    }
    private getClientOption() {
        // Pass languages that should be enabled to server.
        let documentSelector = [];
        for (var langId of ShaderLanguageClient.getSupportedLangId()) {
            if (ShaderLanguageClient.isEnabledLangId(langId)) {
                documentSelector.push({ scheme: 'file', language: langId });
            }
        }
        const self = this;
        const clientRef = this.clientRef;
        const middleware: Middleware = {
            async provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken, next: ProvideDocumentSymbolsSignature) {
                const result = await next(document, token);
                if (result) {
                    // /!\ Type casting need to match server data sent. /!\
                    let resultArray = result as vscode.DocumentSymbol[];
                    sidebar.onDocumentSymbols(document.uri, resultArray);
                }
                return result;
            },
            workspace: {
                async configuration(params: ConfigurationParams, token: vscode.CancellationToken, next : ConfigurationRequest.HandlerSignature) {
                    // Here we resolve vscode variables ourselves as there is no API for this.
                    // see https://github.com/microsoft/vscode/issues/140056
                    // Only solve them for includes as we are dealing with path.
                    let result = await next(params, token);
                    console.debug("initial configuration", result);
                    let resultArray = result as any[];
                    let config = resultArray[0];
                    config["includes"] = config["includes"].map((include: string) => {
                        return resolveVSCodeVariables(include);
                    });
                    self.includeResolver.updateIncludeDirs(config["includes"]);
                    self.preprocessor.clearCache();
                    console.debug("resolved configuration", config);
                    return [config];
                }
            },
            async didOpen(document: vscode.TextDocument, next) {
                const setting = vscode.workspace.getConfiguration("shader-validator-gs").get<boolean>("clientSideIncludes");
                const enabled = self.shouldPreprocess(document);
                try { fs.appendFileSync('/tmp/shader-validator-debug.txt', `didOpen: ${document.uri} lang=${document.languageId} scheme=${document.uri.scheme} setting=${setting} preprocess=${enabled}\n`); } catch {}
                if (enabled) {
                    await self.sendPreprocessedOpen(document);
                    return;
                }
                await next(document);
            },
            async didChange(event: vscode.TextDocumentChangeEvent, next) {
                if (self.shouldPreprocess(event.document)) {
                    self.sendPreprocessedContentDebounced(event.document);
                    return;
                }
                await next(event);
            },
            handleDiagnostics(uri: vscode.Uri, diagnostics: any[], next) {
                const uriKey = uri.toString();
                const preprocessResult = self.preprocessResults.get(uriKey);
                if (!preprocessResult) {
                    next(uri, diagnostics);
                    return;
                }
                // Remap diagnostics and group by target URI
                const remapped = new Map<string, any[]>();
                for (const diag of diagnostics) {
                    const entries = self.remapDiagnostic(diag, preprocessResult, uri);
                    for (const [targetUri, targetDiag] of entries) {
                        const key = targetUri.toString();
                        if (!remapped.has(key)) {
                            remapped.set(key, []);
                        }
                        remapped.get(key)!.push(targetDiag);
                    }
                }
                // Clear diagnostics on the original URI, then publish remapped ones
                next(uri, []);
                for (const [targetUri, targetDiags] of remapped) {
                    next(vscode.Uri.parse(targetUri), targetDiags);
                }
            },
            async provideInlayHints(document: vscode.TextDocument, viewPort: vscode.Range, token: vscode.CancellationToken, next: ProvideInlayHintsSignature) {
                const uriKey = document.uri.toString();
                const preprocessResult = self.preprocessResults.get(uriKey);
                if (!preprocessResult) {
                    return next(document, viewPort, token);
                }
                const expandedRange = self.preprocessor.mapSourceRangeToExpanded(
                    preprocessResult, uriKey, viewPort.start.line, viewPort.end.line,
                );
                if (!expandedRange) {
                    return [];
                }
                const remappedViewPort = new vscode.Range(
                    expandedRange.start, viewPort.start.character,
                    expandedRange.end, viewPort.end.character,
                );
                const hints = await next(document, remappedViewPort, token);
                if (!hints) {
                    return hints;
                }
                const kept: vscode.InlayHint[] = [];
                for (const hint of hints) {
                    const mapping = self.preprocessor.mapLineToSource(preprocessResult, hint.position.line);
                    if (!mapping || mapping.sourceUri !== uriKey) {
                        continue;
                    }
                    hint.position = new vscode.Position(mapping.sourceLine, hint.position.character);
                    if (hint.textEdits) {
                        const remappedEdits = self.remapInlayHintEdits(hint.textEdits, preprocessResult, uriKey);
                        hint.textEdits = remappedEdits.length > 0 ? remappedEdits : undefined;
                    }
                    kept.push(hint);
                }
                return kept;
            },
        };
        const clientOptions: LanguageClientOptions = {
            // Register the server for shader documents
            documentSelector: documentSelector,
            outputChannel: this.channel ? this.channel : undefined,
            traceOutputChannel: this.channel ? this.channel : undefined,
            middleware: middleware,
            uriConverters: this.serverVersion.platform === ServerPlatform.wasi ? createUriConverters() : undefined,
            errorHandler: this.errorHandler
        };
        return clientOptions;
    }
    private getServerArg(): string[] {
        let commonArgs = [
            "--config",
            getConfigurationAsString()
        ];
        // Add languages support for server.
        const supportedLangIds = ShaderLanguageClient.getSupportedLangId();
        let hasAtLeastOneLangEnabled = false;
        for (let supportedLangId of supportedLangIds) {
            if (ShaderLanguageClient.isEnabledLangId(supportedLangId)) {
                hasAtLeastOneLangEnabled = true;
                commonArgs.push("--" + supportedLangId);
            }
        }
        if (!hasAtLeastOneLangEnabled) {
            vscode.window.showWarningMessage("No language enabled for shader-language-server. Server will still start.");
        }
        return commonArgs;
    }
    private getServerEnv() {
        const trace = vscode.workspace.getConfiguration("shader-validator-gs").get<string>("trace.server");
        const defaultEnv = {
            // https://github.com/rust-lang/rust/issues/117440
            //"RUST_MIN_STACK": "65535", // eslint-disable-line @typescript-eslint/naming-convention
        };
        const env = (trace === "verbose") ? {
            ...defaultEnv,
            "RUST_BACKTRACE": "1", // eslint-disable-line 
            "RUST_LOG": "shader_language_server=trace,shader_sense=trace", // eslint-disable-line @typescript-eslint/naming-convention
        } : (trace === "messages") ? {
            ...defaultEnv,
            "RUST_BACKTRACE": "1", // eslint-disable-line 
            "RUST_LOG": "shader_language_server=info,shader_sense=info", // eslint-disable-line @typescript-eslint/naming-convention
        } : defaultEnv;
        return env;
    }
    private async createLanguageClientStandard(context: vscode.ExtensionContext) : Promise<LanguageClient | null> {
        console.info(`Executing server ${this.serverVersion.path} with working directory ${this.serverVersion.cwd}`);
        const serverOptions: ServerOptions = {
            command: this.serverVersion.path.fsPath, 
            transport: TransportKind.stdio,
            args: this.getServerArg(),
            options: {
                cwd: this.serverVersion.cwd.fsPath,
                env: this.getServerEnv(),
            }
        };
        const clientOptions = this.getClientOption();
        let client = new LanguageClient(
            'shader-validator',
            getChannelName(),
            serverOptions,
            clientOptions,
            context.extensionMode === vscode.ExtensionMode.Development
        );

        // Set clientRef before start so middleware can access the client
        this.clientRef.current = client;

        // Start the client. This will also launch the server.
        return await client.start().then(_ => {
            if (client.isRunning()) {
                return client;
            } else {
                return null;
            }
        }, async e => {
            await client.dispose().catch(_ => {});
            console.error("Failed to start server: " + e);
            return null;
        });
    }
    private async createLanguageClientWASI(context: vscode.ExtensionContext) : Promise<LanguageClient | null> {
        // Load the WASM API
        const wasm: Wasm = await Wasm.load();

        // Load the WASM module. It is stored alongside the extension's JS code.
        // So we can use VS Code's file system API to load it. Makes it
        // independent of whether the code runs in the desktop or the web.
        const serverOptions: ServerOptions = async () => {
            const trace = vscode.workspace.getConfiguration("shader-validator-gs").get<string>("trace.server");
            // Create virtual file systems to access workspaces from wasi app
            const mountPoints: MountPointDescriptor[] = [
                { kind: 'workspaceFolder'}, // Workspaces
            ];
            console.info(`Executing wasi server ${this.serverVersion.path}`);
            const bits = await vscode.workspace.fs.readFile(this.serverVersion.path);
            const bytes: ArrayBuffer = new Uint8Array(bits).buffer;
            const module = await WebAssembly.compile(bytes);

            const options : ProcessOptions = {
                stdio: createStdioOptions(),
                env: this.getServerEnv(),
                args: this.getServerArg(),
                mountPoints: mountPoints,
                trace: trace === "verbose" || trace === "messages",
            };
            // Memory options required by wasm32-wasip1-threads target
            const memory : WebAssembly.MemoryDescriptor = {
                initial: 160,
                maximum: 1024, // Big enough to handle glslang heavy RAM usage.
                shared: true
            };

            // Create a WASM process.
            const wasmProcess = await wasm.createProcess('shader-validator', module, memory, options);

            // Hook stderr to the output channel if trace enabled.
            if (trace === "verbose" || trace === "messages") {
                const decoder = new TextDecoder('utf-8');
                wasmProcess.stderr!.onData(data => {
                    const text = decoder.decode(data);
                    console.log("Received error:", text);
                    this.channel?.appendLine("[shader-language-server::error]" + text.trim());
                });
                wasmProcess.stdout!.onData(data => {
                    const text = decoder.decode(data);
                    console.log("Received data:", text);
                    this.channel?.appendLine("[shader-language-server::data]" + text.trim());
                });
            }
            return startServer(wasmProcess);
        };

        // Now we start client
        const clientOptions = this.getClientOption();

        let client = new LanguageClient(
            'shader-validator',
            getChannelName(),
            serverOptions,
            clientOptions,
            context.extensionMode === vscode.ExtensionMode.Development
        );

        // Set clientRef before start so middleware can access the client
        this.clientRef.current = client;

        // Start the client. This will also launch the server
        return await client.start().then(_ => {
            if (client.isRunning()) {
                return client;
            } else {
                return null;
            }
        }, async e => {
            await client.dispose().catch(_ => {});
            console.error("Failed to start server: " + e);
            return null;
        });
    }

    private async sendPreprocessedOpen(document: vscode.TextDocument): Promise<void> {
        const client = this.clientRef.current;
        if (!client) {
            console.warn("[include-preprocess] clientRef.current is null, skipping");
            return;
        }
        try {
            const result = await this.preprocessor.preprocess(document);
            this.preprocessResults.set(document.uri.toString(), result);

            // Debug: write preprocessed content to temp file
            const basename = path.basename(document.uri.fsPath);
            const tmpPath = `/tmp/shader-preprocessed-${basename}`;
            fs.writeFileSync(tmpPath, result.content);
            console.info(`[include-preprocess] Wrote preprocessed content to ${tmpPath}`);

            await client.sendNotification(DidOpenTextDocumentNotification.type, {
                textDocument: {
                    uri: client.code2ProtocolConverter.asUri(document.uri),
                    languageId: document.languageId,
                    version: document.version,
                    text: result.content,
                }
            });

            // Report include errors as VS Code diagnostics
            const includeDiags = result.errors.map(error => new vscode.Diagnostic(
                new vscode.Range(error.line, 0, error.line, 999),
                error.message,
                vscode.DiagnosticSeverity.Error,
            ));
            for (const diag of includeDiags) {
                diag.source = 'shader-validator (includes)';
            }
            this.includeDiagCollection!.set(document.uri, includeDiags);
        } catch (error) {
            console.error(`Include preprocessing failed for ${document.uri}:`, error);
        }
    }

    private shouldPreprocess(document: vscode.TextDocument): boolean {
        return vscode.workspace.getConfiguration("shader-validator-gs")
            .get<boolean>("clientSideIncludes") === true
            && ShaderLanguageClient.isEnabledLangId(document.languageId)
            && document.uri.scheme === 'file';
    }

    private async sendPreprocessedContent(document: vscode.TextDocument): Promise<void> {
        const client = this.clientRef.current;
        if (!client) {
            return;
        }
        try {
            const result = await this.preprocessor.preprocess(document);
            this.preprocessResults.set(document.uri.toString(), result);

            await client.sendNotification(
                DidChangeTextDocumentNotification.type,
                {
                    textDocument: {
                        uri: client.code2ProtocolConverter.asUri(document.uri),
                        version: document.version,
                    },
                    contentChanges: [
                        { text: result.content },
                    ],
                }
            );

            // Report include errors as VS Code diagnostics
            const includeDiags = result.errors.map(error => new vscode.Diagnostic(
                new vscode.Range(error.line, 0, error.line, 999),
                error.message,
                vscode.DiagnosticSeverity.Error,
            ));
            for (const diag of includeDiags) {
                diag.source = 'shader-validator (includes)';
            }
            if (this.includeDiagCollection) {
                this.includeDiagCollection.set(document.uri, includeDiags);
            }
        } catch (error) {
            // Silently ignore disposed errors (e.g. during server restart)
            if (!(error instanceof Error && error.message.includes('disposed'))) {
                console.error(`Include preprocessing failed for ${document.uri}:`, error);
            }
        }
    }

    private sendPreprocessedContentDebounced(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const existing = this.preprocessTimers.get(key);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        const timer = setTimeout(async () => {
            this.preprocessTimers.delete(key);
            await this.sendPreprocessedContent(document);
        }, 150);
        this.preprocessTimers.set(key, timer);
    }

    private remapDiagnostic(
        diag: any,
        preprocessResult: PreprocessResult,
        mainUri: vscode.Uri,
    ): [vscode.Uri, any][] {
        const startLine = diag.range.start.line;
        const endLine = diag.range.end.line;

        const startMapping = this.preprocessor.mapLineToSource(preprocessResult, startLine);
        const endMapping = this.preprocessor.mapLineToSource(preprocessResult, endLine);

        if (!startMapping) {
            return [[mainUri, diag]];
        }

        const startUri = vscode.Uri.parse(startMapping.sourceUri);

        if (endMapping && startMapping.sourceUri === endMapping.sourceUri) {
            // Same source file — simple remap
            const remapped = { ...diag };
            remapped.range = {
                start: { line: startMapping.sourceLine, character: diag.range.start.character },
                end: { line: endMapping.sourceLine, character: diag.range.end.character },
            };
            return [[startUri, remapped]];
        }

        // Cross-boundary diagnostic — assign to start file
        const remapped = { ...diag };
        remapped.range = {
            start: { line: startMapping.sourceLine, character: diag.range.start.character },
            end: { line: startMapping.sourceLine, character: 999 },
        };
        remapped.message = diag.message + ' (diagnostic continues into included file)';
        return [[startUri, remapped]];
    }

    private remapInlayHintEdits(
        edits: vscode.TextEdit[],
        preprocessResult: PreprocessResult,
        mainUriKey: string,
    ): vscode.TextEdit[] {
        const result: vscode.TextEdit[] = [];
        for (const edit of edits) {
            const startMapping = this.preprocessor.mapLineToSource(preprocessResult, edit.range.start.line);
            const endMapping = this.preprocessor.mapLineToSource(preprocessResult, edit.range.end.line);
            if (!startMapping || !endMapping) {
                continue;
            }
            if (startMapping.sourceUri !== mainUriKey || endMapping.sourceUri !== mainUriKey) {
                continue;
            }
            edit.range = new vscode.Range(
                startMapping.sourceLine, edit.range.start.character,
                endMapping.sourceLine, edit.range.end.character,
            );
            result.push(edit);
        }
        return result;
    }

}