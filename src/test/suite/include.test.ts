import * as assert from 'assert';

import * as vscode from 'vscode';
import { activate } from './utils';

suite('Include mapping Test Suite', () => {
	test('Document symbols use source line numbers', async () => {
		const docUri = await findIncludeTestFile();
		await activate(docUri, true);

		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			docUri,
		);
		assert.ok(symbols, 'No document symbols returned');

		const main = symbols.find(symbol => symbol.name === 'main');
		assert.ok(main, 'Main function symbol not found');
		assert.strictEqual(main.selectionRange.start.line, 3, 'Main function line was not remapped');

		assert.strictEqual(
			symbols.some(symbol => symbol.name === 'include_lib_value'),
			false,
			'Symbols from included files should not be part of the document outline',
		);

		const include = symbols.find(symbol => symbol.name === 'include-lib.glsl');
		assert.ok(include, 'Include directive symbol not found');
		assert.strictEqual(include.selectionRange.start.line, 1, 'Include directive line is wrong');
	}).timeout(15000);

	test('Definition from an include maps to the included file', async () => {
		const docUri = await findIncludeTestFile();
		const document = await activateDocument(docUri);

		const line = document.lineAt(4).text;
		const character = line.indexOf('include_lib_value') + 1;
		const target = await getFirstDefinition(docUri, new vscode.Position(4, character));

		assert.ok(target, 'No definition found for include_lib_value');
		assert.ok(target.uri.path.endsWith('/include-lib.glsl'), `Unexpected target file: ${target.uri.toString()}`);
		assert.strictEqual(target.line, 2, 'Definition line in included file is wrong');
	}).timeout(15000);

	test('Definition from a nested include maps to the nested file', async () => {
		const docUri = await findIncludeTestFile();
		const document = await activateDocument(docUri);

		const line = document.lineAt(4).text;
		const character = line.indexOf('include_leaf_value') + 1;
		const target = await getFirstDefinition(docUri, new vscode.Position(4, character));

		assert.ok(target, 'No definition found for include_leaf_value');
		assert.ok(target.uri.path.endsWith('/include-leaf.glsl'), `Unexpected target file: ${target.uri.toString()}`);
		assert.strictEqual(target.line, 0, 'Definition line in nested included file is wrong');
	}).timeout(15000);

	test('Definition on an include directive opens the included file', async () => {
		const docUri = await findIncludeTestFile();
		const document = await activateDocument(docUri);

		const line = document.lineAt(1).text;
		const character = line.indexOf('include-lib.glsl') + 1;
		const target = await getFirstDefinition(docUri, new vscode.Position(1, character));

		assert.ok(target, 'No definition found for include directive');
		assert.ok(target.uri.path.endsWith('/include-lib.glsl'), `Unexpected target file: ${target.uri.toString()}`);
		assert.strictEqual(target.line, 0, 'Include directive should target the first line of the included file');
	}).timeout(15000);
});

async function findIncludeTestFile(): Promise<vscode.Uri> {
	const docUri = await vscode.workspace.findFiles("include-main.glsl");
	assert.ok(docUri.length > 0, 'include-main.glsl test fixture not found');
	return docUri[0];
}

async function activateDocument(docUri: vscode.Uri): Promise<vscode.TextDocument> {
	const opened = await activate(docUri, true);
	assert.ok(opened, 'Failed to open include test document');
	return opened[0];
}

async function getFirstDefinition(
	docUri: vscode.Uri,
	position: vscode.Position,
): Promise<{ uri: vscode.Uri; line: number } | undefined> {
	const result = await vscode.commands.executeCommand<any[]>(
		'vscode.executeDefinitionProvider',
		docUri,
		position,
	);
	if (!result || result.length === 0) {
		return undefined;
	}
	const item = result[0];
	const uri: vscode.Uri = item.targetUri ?? item.uri;
	const range: vscode.Range = item.targetSelectionRange ?? item.targetRange ?? item.range;
	return { uri, line: range.start.line };
}
