/**
 * The entry file, imported in HTML directly.
 */

import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { takeSessionInProgress } from "./base";
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
		const spineItem = await rs.openEpub(path);
		await initReaderFrame(spineItem);
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
		rs.reloadCurrent(true)
			.then(spineItem => {
				return initReaderFrame(spineItem);
			})
			.catch(err => {
				window.alert(err);
				enableClickToOpen();
			});
	} else {
		enableClickToOpen();
	}

	getCurrentWindow().listen<{
		paths: string[];
		position: PhysicalPosition;
	}>("tauri://drag-drop", event => {
		const paths = event.payload.paths;
		if (paths.length == 0) {
		} else if (paths.length > 1) {
			window.alert("One at a time.");
		} else {
			const path = paths[0];
			const parts = path.split(".");
			if (parts[parts.length - 1].toLowerCase() != "epub") {
				window.alert("EPUB only");
			} else {
				// Proceed
				rs.openEpub(path)
					.then(spineItem => {
						return initReaderFrame(spineItem);
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
});
