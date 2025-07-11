/**
 * The entry file, imported in HTML directly.
 */

import { open } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";

import { file_picker_multiple_file_alert, file_picker_not_epub_alert } from "./strings.json";

import { AboutPub, takeSessionInProgress } from "./base";
import { getGlobalContext } from "./context";
import * as rs from "./invoke";
import { ReadScreen } from "./readscreen";

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
	rs.setDragDropHandler(paths => {
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

function startReading(aboutPub: AboutPub): void {
	getGlobalContext().readScreen?.deinit();
	getGlobalContext().readScreen = new ReadScreen(aboutPub);
}

function openChosenFileAt(path: string): Promise<void> {
	return rs
		.openEpub(path)
		.then(about => {
			showClickToOpen(false);
			startReading(about);
		})
		.catch(window.alert);
}

function showClickToOpen(yes: boolean): HTMLElement {
	const elem = document.getElementById("og-click-to-open") as HTMLElement;
	// inline style is hidden in HTML
	elem.style.visibility = yes ? "" : "hidden";
	return elem;
}

function start(about: null | AboutPub): void {
	if (about) {
		startReading(about);
	} else {
		showWelcomeScreen();
	}
	enableDragAndDrop();
	rs.setMenuHandlerForFileOpen(chooseAndMaybeOpenFile);
}

document.addEventListener("DOMContentLoaded", () => {
	load("prefs.json", { autoSave: true }).then(store => {
		getGlobalContext().prefsStore = store;
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
