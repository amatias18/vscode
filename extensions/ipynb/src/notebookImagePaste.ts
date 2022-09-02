/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

class CopyPasteEditProvider implements vscode.DocumentPasteEditProvider {

	async provideDocumentPasteEdits(
		document: vscode.TextDocument,
		_ranges: readonly vscode.Range[],
		dataTransfer: vscode.DataTransfer,
		_token: vscode.CancellationToken
	): Promise<vscode.DocumentPasteEdit | undefined> {

		const enabled = vscode.workspace.getConfiguration('ipynb', document).get('experimental.pasteImages.enabled', false);
		if (!enabled) {
			return undefined;
		}

		const attachmentEdit = await buildImageMarkdown(dataTransfer, document);
		if (attachmentEdit) {
			return { insertText: attachmentEdit.snippet, additionalEdit: attachmentEdit.edit };
		} else {
			return undefined;
		}
	}
}

class ImageDropEditProvider implements vscode.DocumentDropEditProvider {
	async provideDocumentDropEdits(
		document: vscode.TextDocument,
		_position: vscode.Position,
		dataTransfer: vscode.DataTransfer,
		_token: vscode.CancellationToken
	): Promise<vscode.DocumentDropEdit | undefined> {

		const enabled = vscode.workspace.getConfiguration('ipynb', document).get('experimental.dropImages.enabled', false);
		if (!enabled) {
			return undefined;
		}

		const attachmentEdit = await buildImageMarkdown(dataTransfer, document);
		if (attachmentEdit) {
			return { insertText: attachmentEdit.snippet, additionalEdit: attachmentEdit.edit };
		} else {
			return undefined;
		}
	}

}

/**
 *  Taken from https://github.com/microsoft/vscode/blob/743b016722db90df977feecde0a4b3b4f58c2a4c/src/vs/base/common/buffer.ts#L350-L387
 */
function encodeBase64(buffer: Uint8Array, padded = true, urlSafe = false) {
	const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const base64UrlSafeAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

	const dictionary = urlSafe ? base64UrlSafeAlphabet : base64Alphabet;
	let output = '';

	const remainder = buffer.byteLength % 3;

	let i = 0;
	for (; i < buffer.byteLength - remainder; i += 3) {
		const a = buffer[i + 0];
		const b = buffer[i + 1];
		const c = buffer[i + 2];

		output += dictionary[a >>> 2];
		output += dictionary[(a << 4 | b >>> 4) & 0b111111];
		output += dictionary[(b << 2 | c >>> 6) & 0b111111];
		output += dictionary[c & 0b111111];
	}

	if (remainder === 1) {
		const a = buffer[i + 0];
		output += dictionary[a >>> 2];
		output += dictionary[(a << 4) & 0b111111];
		if (padded) { output += '=='; }
	} else if (remainder === 2) {
		const a = buffer[i + 0];
		const b = buffer[i + 1];
		output += dictionary[a >>> 2];
		output += dictionary[(a << 4 | b >>> 4) & 0b111111];
		output += dictionary[(b << 2) & 0b111111];
		if (padded) { output += '='; }
	}

	return output;
}

/**
 * takes in the TextDocument of a cell, and returns the vscode.NotebookCell that contains it
 * @param cellDocument TextDocument of a vscode.NotebookCell
 * @returns vscode.NotebookCell of the passed in TextDocument
 */
function getCellFromCellDocument(cellDocument: vscode.TextDocument): vscode.NotebookCell | undefined {
	for (const notebook of vscode.workspace.notebookDocuments) {
		if (notebook.uri.path === cellDocument.uri.path) {
			for (const cell of notebook.getCells()) {
				if (cell.document === cellDocument) {
					return cell;
				}
			}
		}
	}
	return undefined;
}

/**
 * function to create updated metadata for a cell and resolve naming conflicts.
 * @param b64 base64 encoded image data
 * @param cell vscode.NotebookCell that image is being added to
 * @param filename filename (prefix) of the image
 * @param filetype filetype (suffix)
 * @param startingAttachments attachents already in the cell metadata
 * @returns obj with a filename of the image, and the updated metadata for the cell
 */
function buildAttachment(b64: string, cell: vscode.NotebookCell, filename: string, filetype: string, startingAttachments: any): { metadata: { [key: string]: any }; filename: string } {
	const outputMetadata = { ...cell.metadata };
	let tempFilename = filename + filetype;

	if (!outputMetadata.custom) {
		outputMetadata['custom'] = { 'attachments': { [tempFilename]: { 'image/png': b64 } } };
	} else if (!outputMetadata.custom.attachments) {
		outputMetadata.custom['attachments'] = { [tempFilename]: { 'image/png': b64 } };
	} else {
		for (let appendValue = 2; tempFilename in startingAttachments; appendValue++) {
			const objEntries = Object.entries(startingAttachments[tempFilename]);
			if (objEntries.length) { // check that mime:b64 are present
				const [, attachmentb64] = objEntries[0];
				if (attachmentb64 === b64) { // checking if filename can be reused, based on camparison of image data
					break;
				} else {
					tempFilename = filename.concat(`-${appendValue}`) + filetype;
				}
			}
		}
		outputMetadata.custom.attachments[tempFilename] = { 'image/png': b64 };
	}
	return {
		metadata: outputMetadata,
		filename: tempFilename
	};
}

/**
 * create a markdown image reference and workspace edit for an image being inputted to a markdown notebook cell
 * @param dataTransfer dataTransfer item containing the image
 * @param document TextDocument that image is being dropped into
 * @returns a promise for an object containing the pastesnippet as well as the workspace edit
 */
async function buildImageMarkdown(dataTransfer: vscode.DataTransfer, document: vscode.TextDocument): Promise<{ snippet: vscode.SnippetString; edit: vscode.WorkspaceEdit } | undefined> {
	// get b64 data from paste
	// TODO: dataTransfer.get() limits to one image dropped
	const dataItem = dataTransfer.get('image/png');
	if (!dataItem) {
		return undefined;
	}
	const fileDataAsUint8 = await dataItem.asFile()?.data();
	if (!fileDataAsUint8) {
		return undefined;
	}

	// get filename data from paste
	const givenFilename = dataItem.asFile()?.name;
	if (!givenFilename) {
		return undefined;
	}
	const separatorIndex = givenFilename?.lastIndexOf('.');
	const filename = givenFilename?.slice(0, separatorIndex);
	const filetype = givenFilename?.slice(separatorIndex);
	if (!filename || !filetype) {
		return undefined;
	}

	const currentCell = getCellFromCellDocument(document);
	if (!currentCell) {
		return undefined;
	}
	const notebookUri = currentCell.notebook.uri;

	// create updated metadata for cell (prep for WorkspaceEdit)
	const b64string = encodeBase64(fileDataAsUint8);
	const startingAttachments = currentCell.metadata.custom?.attachments;
	const newAttachment = buildAttachment(b64string, currentCell, filename, filetype, startingAttachments);

	// build edits
	const nbEdit = vscode.NotebookEdit.updateCellMetadata(currentCell.index, newAttachment.metadata);
	const workspaceEdit = new vscode.WorkspaceEdit();
	workspaceEdit.set(notebookUri, [nbEdit]);

	// create a snippet for paste
	const pasteSnippet = new vscode.SnippetString();
	pasteSnippet.appendText('![');
	pasteSnippet.appendPlaceholder(`${givenFilename}`);
	pasteSnippet.appendText(`](attachment:${newAttachment.filename})`);

	return {
		snippet: pasteSnippet,
		edit: workspaceEdit
	};
}

export function imagePasteSetup() {
	const selector: vscode.DocumentSelector = { notebookType: 'jupyter-notebook', language: 'markdown' };
	return vscode.languages.registerDocumentPasteEditProvider(selector, new CopyPasteEditProvider(), {
		pasteMimeTypes: ['image/png'],
	});
}

export function imageDropSetup() {
	const selector: vscode.DocumentSelector = { notebookType: 'jupyter-notebook', language: 'markdown' };
	return vscode.languages.registerDocumentDropEditProvider(selector, new ImageDropEditProvider());
}
