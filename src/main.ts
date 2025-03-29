import { invoke } from "@tauri-apps/api/core";

document.body.onclick = async () => {
	const result: string = await invoke("open_epub");
	alert(`Opened "${result}"!`);
};
