/**
 * The entry file, imported in HTML directly.
 */

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";

import { file_picker_multiple_file_alert, file_picker_not_epub_alert } from "./strings.json";

import { SpineItemDataAndProgress, takeSessionInProgress } from "./base";
import { Context } from "./context";
import * as rs from "./invoke";
import { initReaderFrame, loadContent } from "./lib";

function chooseAndMaybeOpenFile(): Promise<void> {
	return open({
		directory: false,
		filters: [
			{
				name: "EPUB",
				extensions: ["epub"],
			},
		],
	}).then(filepath => {
		if (filepath) return openChosenFileAt(filepath);
	});
}

function showWelcomeScreen(): void {
	const clickToOpen = showClickToOpen(true);
	clickToOpen.onclick = chooseAndMaybeOpenFile;
}

function enableDragAndDrop(): void {
	getCurrentWebviewWindow().listen<{
		paths: string[];
		position: PhysicalPosition;
	}>("tauri://drag-drop", event => {
		const paths = event.payload.paths;
		if (paths.length == 0) {
		} else if (paths.length > 1) {
			window.alert(file_picker_multiple_file_alert);
		} else {
			const path = paths[0];
			const parts = path.split(".");
			if (parts[parts.length - 1].toLowerCase() != "epub") {
				window.alert(file_picker_not_epub_alert);
			} else {
				openChosenFileAt(path); // don't wait
			}
		}
	});
}

function openChosenFileAt(path: string): Promise<void> {
	return rs
		.openEpub(path)
		.then(([spineItem, percentage]) => {
			showClickToOpen(false);
			initReaderFrame(spineItem, percentage); // don't wait
		})
		.catch(window.alert);
}

function showClickToOpen(yes: boolean): HTMLElement {
	const elem = document.getElementById("og-click-to-open") as HTMLElement;
	// inline style is hidden in HTML
	elem.style.visibility = yes ? "" : "hidden";
	return elem;
}

function start(read: null | SpineItemDataAndProgress): void {
	if (read) {
		const [spineItem, percentage] = read;
		initReaderFrame(spineItem, percentage); // don't wait
	} else {
		showWelcomeScreen();
	}
	enableDragAndDrop();
	getCurrentWebviewWindow().listen("menu/f_o", chooseAndMaybeOpenFile);
}

document.addEventListener("DOMContentLoaded", () => {
	loadContent();

	load("prefs.json", { autoSave: true }).then(store => {
		Context.prefsStore = store;
	});

	if (takeSessionInProgress()) {
		rs.reloadBook()
			.then(start)
			.catch(err => {
				console.error(err);
				start(null);
			});
	} else {
		rs.openEpubIfLoaded()
			.then(start)
			.catch(err => {
				window.alert(err);
				start(null);
			});
	}
});
