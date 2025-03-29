import { invoke } from "@tauri-apps/api/core";

async function openEpub() {
    const result: string = await invoke("open_epub");
    if (!result) {
        window.alert("Could not open.");
        return;
    }

    const parser = new DOMParser();
    const epubPageDoc = parser.parseFromString(result, "application/xhtml+xml");
    document.body.replaceChildren(...epubPageDoc.body.children);
}

async function goToNextChapter() {
    const result: string = await invoke("next_chapter");
    if (!result) {
        return;
    }

    const parser = new DOMParser();
    const epubPageDoc = parser.parseFromString(result, "application/xhtml+xml");
    document.body.replaceChildren(...epubPageDoc.body.children);
}

document.addEventListener("DOMContentLoaded", () => {
	const elemClickToOpen = document.getElementById("click-to-open");
	elemClickToOpen?.addEventListener("click", openEpub);

    document.body.addEventListener("keyup", (event) => {
        if (event.key === "ArrowRight") {
            event.preventDefault();
            goToNextChapter();
        }
    });
});
