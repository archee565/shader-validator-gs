import * as vscode from 'vscode';

export interface LineMapping {
    sourceUri: string;
    sourceLine: number;
}

export interface IncludeError {
    line: number;
    includePath: string;
    message: string;
}

export interface PreprocessResult {
    content: string;
    lineMap: LineMapping[];
    errors: IncludeError[];
    includedFiles: Set<string>;
}

// Matches #include "path" or #include <path> (with optional whitespace)
const INCLUDE_REGEX = /^[ \t]*#[ \t]*include[ \t]+(?:"([^"]+)"|<([^>]+)>)/;
// Matches #line directives that have a filename (C/C++ style), e.g. #line 1 "file.glsl"
const LINE_WITH_FILE_REGEX = /^[ \t]*#[ \t]*line[ \t]+\d+[ \t]+"[^"]*"/;

export class IncludeResolver {
    private includeDirs: string[] = [];
    private fileContentCache: Map<string, string> = new Map();

    updateIncludeDirs(dirs: string[]): void {
        this.includeDirs = dirs;
    }

    async resolveInclude(
        includePath: string,
        baseUri: vscode.Uri,
    ): Promise<vscode.Uri | null> {
        // Try relative to the base document's directory
        const baseDir = vscode.Uri.joinPath(baseUri, '..');
        const relativeUri = vscode.Uri.joinPath(baseDir, includePath);
        if (await this.fileExists(relativeUri)) {
            return relativeUri;
        }

        // Try each include directory
        for (const dir of this.includeDirs) {
            const dirUri = vscode.Uri.file(dir);
            const candidateUri = vscode.Uri.joinPath(dirUri, includePath);
            if (await this.fileExists(candidateUri)) {
                return candidateUri;
            }
        }

        return null;
    }

    async readFile(uri: vscode.Uri): Promise<string | null> {
        const key = uri.toString();
        const cached = this.fileContentCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(bytes);
            this.fileContentCache.set(key, content);
            return content;
        } catch {
            return null;
        }
    }

    invalidateCache(uri?: vscode.Uri): void {
        if (uri) {
            this.fileContentCache.delete(uri.toString());
        } else {
            this.fileContentCache.clear();
        }
    }

    private async fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }
}

export class ShaderPreprocessor {
    private resolver: IncludeResolver;
    private cache: Map<string, { result: PreprocessResult; version: number }> = new Map();

    constructor(resolver: IncludeResolver) {
        this.resolver = resolver;
    }

    async preprocess(document: vscode.TextDocument): Promise<PreprocessResult> {
        const uriKey = document.uri.toString();
        const cached = this.cache.get(uriKey);
        if (cached && cached.version === document.version) {
            return cached.result;
        }

        const result = await this.preprocessInternal(
            document.uri,
            document.getText(),
            new Set<string>(),
            [],
        );

        this.cache.set(uriKey, { result, version: document.version });
        return result;
    }

    invalidateForFile(uri: vscode.Uri): void {
        const uriKey = uri.toString();
        const cached = this.cache.get(uriKey);
        if (cached && cached.result.includedFiles.has(uriKey)) {
            this.cache.delete(uriKey);
        }
        this.resolver.invalidateCache(uri);
    }

    clearCache(): void {
        this.cache.clear();
        this.resolver.invalidateCache();
    }

    mapLineToSource(
        result: PreprocessResult,
        preprocessedLine: number,
    ): LineMapping | undefined {
        return result.lineMap[preprocessedLine];
    }

    private async preprocessInternal(
        uri: vscode.Uri,
        content: string,
        visited: Set<string>,
        lineMap: LineMapping[],
    ): Promise<PreprocessResult> {
        const errors: IncludeError[] = [];
        const includedFiles = new Set<string>();
        const lines = content.split('\n');
        const outputLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = INCLUDE_REGEX.exec(line);

            if (match) {
                // Capture group 1 = "path", group 2 = <path>
                const includePath = match[1] ?? match[2];
                const includeUri = await this.resolver.resolveInclude(includePath, uri);

                if (includeUri === null) {
                    // Include not found — replace with empty line to prevent
                    // glslang from encountering the #include directive
                    errors.push({
                        line: i,
                        includePath,
                        message: `Include not found: "${includePath}"`,
                    });
                    outputLines.push('');
                    lineMap.push({ sourceUri: uri.toString(), sourceLine: i });
                } else {
                    const includeKey = includeUri.toString();
                    if (visited.has(includeKey)) {
                        errors.push({
                            line: i,
                            includePath,
                            message: `Circular include detected: "${includePath}"`,
                        });
                        outputLines.push('');
                        lineMap.push({ sourceUri: uri.toString(), sourceLine: i });
                    } else {
                        visited.add(includeKey);
                        const includedContent = await this.resolver.readFile(includeUri);
                        if (includedContent !== null) {
                            const nested = await this.preprocessInternal(
                                includeUri,
                                includedContent,
                                visited,
                                lineMap,
                            );
                            includedFiles.add(includeKey);
                            for (const f of nested.includedFiles) {
                                includedFiles.add(f);
                            }
                            errors.push(...nested.errors);
                            outputLines.push(...nested.content.split('\n'));
                        } else {
                            errors.push({
                                line: i,
                                includePath,
                                message: `Failed to read include: "${includePath}"`,
                            });
                            outputLines.push('');
                            lineMap.push({ sourceUri: uri.toString(), sourceLine: i });
                        }
                        visited.delete(includeKey);
                    }
                }
            } else {
                outputLines.push(line);
                lineMap.push({ sourceUri: uri.toString(), sourceLine: i });
            }
        }

        return {
            content: outputLines.join('\n'),
            lineMap,
            errors,
            includedFiles,
        };
    }
}
