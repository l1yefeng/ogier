/**
 * The entry file, imported in HTML directly.
 */

import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";

import { file_picker_multiple_file_alert, file_picker_not_epub_alert } from "./strings.json";

import { takeSessionInProgress } from "./base";
import { Context } from "./context";
import * as rs from "./invoke";
import { initReaderFrame, loadContent } from "./lib";

async function chooseFileAndOpen(): Promise<void> {
	const path = await open({
		directory: false,
		filters: [
			{
				name: "EPUB",
				extensions: ["epub"],
			},
		],
	});
	if (path) {
		const [spineItem, percentage] = await rs.openEpub(path);
		await initReaderFrame(spineItem, percentage);
	}
}

document.addEventListener("DOMContentLoaded", () => {
	loadContent();

	const elemClickToOpen = document.getElementById("og-click-to-open") as HTMLElement;

	const enableClickToOpen = () => {
		elemClickToOpen.style.visibility = "";
		elemClickToOpen.onclick = () => {
			chooseFileAndOpen().catch(err => {
				window.alert(err);
			});
		};
	};

	if (takeSessionInProgress()) {
		rs.reloadBook()
			.then(([spineItem, percentage]) => {
				return initReaderFrame(spineItem, percentage);
			})
			.catch(err => {
				window.alert(err);
				enableClickToOpen();
			});
	} else {
		rs.openEpubIfLoaded()
			.then(result => {
				if (result != null) {
					const [spineItem, percentage] = result;
					return initReaderFrame(spineItem, percentage);
				} else {
					enableClickToOpen();
				}
			})
			.catch(err => {
				window.alert(err);
				enableClickToOpen();
			});
	}

	getCurrentWindow().listen<{
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
				// Proceed
				rs.openEpub(path)
					.then(([spineItem, percentage]) => {
						return initReaderFrame(spineItem, percentage);
					})
					.catch(err => {
						window.alert(err);
					});
			}
		}
	});

	getCurrentWindow().listen("menu/f_o", () => {
		chooseFileAndOpen().catch(err => {
			window.alert(err);
		});
	});

	// App initializtion, not dependent on EPUB
	load("prefs.json", { autoSave: true })
		.then(store => {
			Context.prefsStore = store;
		})
		.catch(err => {
			window.alert(err);
		});
});
