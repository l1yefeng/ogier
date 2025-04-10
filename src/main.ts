import { takeSessionInProgress } from "./base";
import * as rs from "./invoke";
import { initReaderFrame, loadContent } from "./lib";

document.addEventListener("DOMContentLoaded", () => {
	loadContent();

	const elemClickToOpen = document.getElementById("og-click-to-open") as HTMLElement;

	const enableClickToOpen = () => {
		elemClickToOpen.style.visibility = "";
		elemClickToOpen.onclick = () => {
			rs.openEpub()
				.then(spineItem => {
					if (spineItem) {
						// got the book.
						elemClickToOpen.remove();
						initReaderFrame(spineItem);
					}
					// if null, user has not opened one
				})
				.catch(err => {
					window.alert(err);
				});
		};
	};

	if (takeSessionInProgress()) {
		rs.reloadCurrent()
			.then(spineItem => {
				elemClickToOpen.remove();
				return initReaderFrame(spineItem);
			})
			.catch(err => {
				window.alert(err);
				enableClickToOpen();
			});
	} else {
		enableClickToOpen();
	}
});
