import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
	end_of_spine_message,
	toc_default_title,
	toc_unavailable_message,
} from "./strings.json";

import {
	AboutPub,
	anchoredSamePageLocation,
	FontPrefer,
	isLocationNear,
	PubHelper,
	TaskRepeater,
	UrlAndPercentage,
} from "./base";
import * as rs from "./invoke";
import { DetailsModal, NavModal, PreviewModal } from "./modal";
import { Reader } from "./reader";
import { FilewiseStylesEditor } from "./filewise";

class ReadScreenDomContext {
	#tocBtn: HTMLButtonElement;
	#tocBtnLabel: HTMLElement;

	set handleKeyEvent(listener: (event: KeyboardEvent) => any) {
		document.body.onkeydown = listener;
	}

	disableTocBtn() {
		this.#tocBtn.disabled = true;
		this.#tocBtn.title = toc_unavailable_message;
	}

	updateTocBtnLabel(text: string, lang: string) {
		this.#tocBtnLabel.textContent = text;
		this.#tocBtnLabel.lang = lang;
	}

	resetTocBtnLabel() {
		this.#tocBtnLabel.removeAttribute("lang");
		this.#tocBtnLabel.textContent = toc_default_title;
	}

	private constructor() {
		this.#tocBtn = document.getElementById("og-toc-button") as HTMLButtonElement;
		this.#tocBtnLabel = document.getElementById("og-toc-button-label") as HTMLElement;

		// Unhide the reader frame
		const frame = document.getElementById("og-frame") as HTMLDivElement;
		frame.style.display = "";

		// Assign handler to toc button (it's not necessarily enabled eventually)
		this.#tocBtn.onclick = () => NavModal.get().show();
	}

	// Singleton
	private static self?: ReadScreenDomContext;
	static get(): ReadScreenDomContext {
		if (!ReadScreenDomContext.self) ReadScreenDomContext.self = new ReadScreenDomContext();
		return ReadScreenDomContext.self;
	}
}

export class ReadScreen {
	domContext: ReadScreenDomContext;
	filewiseStylesEditor: FilewiseStylesEditor;
	reader: Reader;
	refreshTocBtnLabelTask: TaskRepeater;
	pub: AboutPub;
	pubHelper: PubHelper;
	jumpHistory: UrlAndPercentage[];
	pageUrl: URL;

	get pageIndexInSpine(): number | undefined {
		return this.pubHelper.indexInSpine(this.pageUrl);
	}

	constructor(aboutPub: AboutPub) {
		this.domContext = ReadScreenDomContext.get();
		this.filewiseStylesEditor = FilewiseStylesEditor.get();
		this.reader = Reader.get();
		this.refreshTocBtnLabelTask = new TaskRepeater(500);
		this.pub = aboutPub;
		this.pubHelper = new PubHelper(aboutPub);
		this.jumpHistory = [];

		// Update keyboard event listener
		this.domContext.handleKeyEvent = (event: KeyboardEvent) => this.handleKeyEvent(event);

		// Update reader click event listener
		this.reader.domContext.handleClickEvent = (event: Event) =>
			this.handleReaderClickEvent(event);

		// retrieve reading position
		this.pageUrl = aboutPub.pubLandingPage; // expected to be updated at once
		rs.getReadingPosition()
			.then(result => {
				let percentage = null;
				if (result) {
					this.pageUrl = result[0];
					percentage = result[1];
				}
				return this.readPage(percentage);
			})
			.then(() => {
				return this.initDetailsAndTocModals();
			});

		// TODO re-evaluate position for this
		getCurrentWebviewWindow().listen<FontPrefer>("menu/v_fp", () => {
			this.reader.styler.loadAppPrefs();
		});
	}

	deinit(): void {
		this.reader.saveReadingProgressTask.stop();
		this.refreshTocBtnLabelTask.stop();
	}

	async readPage(percentageOrId: string | number | null): Promise<void> {
		this.refreshTocBtnLabelTask.stop();
		await this.reader.open(this.pageUrl, percentageOrId, this.pubHelper.lang);
		this.refreshTocBtnLabelTask.restart(this.#setTocBtnLabel);
	}

	#setTocBtnLabel = () => {
		// TODO: optimize `mostRecentNavPoint`
		const btn = NavModal.get().mostRecentNavPoint(
			this.pageUrl.pathname,
			this.reader.calculateOffsetPx(),
			id => this.reader.calculateTargetOffsetPx(id) ?? 0,
		);
		if (btn) {
			this.domContext.updateTocBtnLabel(
				btn.textContent!,
				btn.closest<HTMLElement>("[lang]")!.lang,
			);
		} else {
			this.domContext.resetTocBtnLabel();
		}
	};

	handleKeyEvent(event: KeyboardEvent) {
		if (event.key == "Escape") {
			// TODO: focus on the reader so that Arrow Up/Down is useful
			// this.reader.domContext.host.focus();
			// FIXME: currently nav modal returns with value even if esc
		}

		if (event.target instanceof Element) {
			const elem = event.target;
			if (elem.closest("input")) return;
			if (elem.closest("button")) return;
			if (elem.closest("dialog")) return;
		}

		if (event.key == "ArrowRight" || (event.ctrlKey && event.key == "PageDown")) {
			event.preventDefault();
			this.moveInSpine(true);
		} else if (event.key == "ArrowLeft" || (event.ctrlKey && event.key == "PageUp")) {
			event.preventDefault();
			this.moveInSpine(false);
		} else if (event.key == "t") {
			event.preventDefault();
			NavModal.get().show();
		} else if (event.key == "d" || event.key == "i") {
			// TODO focus different tabs
			event.preventDefault();
			DetailsModal.get().show();
		}
	}

	handleReaderClickEvent(event: Event) {
		// find the nearest nesting anchor
		if (!(event.target instanceof Element)) {
			return;
		}
		const elemAnchor = event.target.closest("a");
		if (!elemAnchor) {
			return;
		}

		event.preventDefault();
		const elemNoteId = anchoredSamePageLocation(elemAnchor);
		if (elemNoteId) {
			this.previewSamePageLocation(elemAnchor, elemNoteId);
		} else {
			const url = URL.parse(elemAnchor.getAttribute("href") ?? "", this.pageUrl);
			if (url) {
				if (
					url.protocol == "http:" ||
					url.protocol == "https:" ||
					url.protocol == "mailto:" ||
					url.protocol == "tel:"
				) {
					// open externally
					confirm(`Open ${url} using system default application`, {
						title: "Confirm",
						kind: "warning",
					})
						.then(confirmed => {
							if (confirmed) {
								return openUrl(url);
							}
						})
						.catch(err => {
							window.alert(`Error opening ${url}: ${err}`);
						});
				} else {
					this.jumpTo(url);
				}
			}
		}
	}

	jumpTo(url: URL): void {
		const id = url.hash.slice(1) || null;
		url.hash = "";
		const percentage = this.reader.calculatePercentage();
		this.jumpHistory.push([this.pageUrl, percentage]);
		this.pageUrl = url;
		this.readPage(id); // don't wait
	}

	moveInSpine(forward: boolean): void {
		const spine = this.pub.pubSpine;
		let index = this.pageIndexInSpine;
		if (index == undefined) {
			// If not in spine, do nothing.
			return;
		}

		index += forward ? +1 : -1;
		if (index < 0 || index >= spine.length) {
			window.alert(end_of_spine_message);
			return;
		}
		const percentage = forward ? 0.0 : 1.0;
		// TODO: consider the impact to jump history
		this.pageUrl = spine[index];
		this.readPage(percentage); // don't wait
	}

	async initDetailsAndTocModals(): Promise<void> {
		const webWindow = getCurrentWebviewWindow();

		const detailsModal = DetailsModal.get();
		detailsModal.init(this.pub, this.pubHelper);

		webWindow.listen("menu/f_d", () => detailsModal.show());

		const navModal = NavModal.get();
		try {
			await navModal.init(this.pub, this.pubHelper);
		} catch (err) {
			console.error("Error loading TOC:", err);
			this.domContext.disableTocBtn();
			return;
		}
		navModal.setupTocGoTo(url => this.jumpTo(url));

		webWindow.listen("menu/f_n", () => navModal.show());
	}

	findPreviewContent(elemLocation: HTMLElement): HTMLElement {
		// First, try to locate a <li>, and use its content
		let elemLi: HTMLLIElement | null = null;
		if (elemLocation instanceof HTMLLIElement) {
			elemLi = elemLocation;
		} else if (elemLocation.parentElement instanceof HTMLLIElement) {
			elemLi = elemLocation.parentElement;
		}
		if (elemLi) {
			return elemLi;
		}

		// Next, use its parent if it's a <a>
		if (elemLocation instanceof HTMLAnchorElement) {
			const parent = elemLocation.parentElement;
			if (parent) {
				return parent;
			}
		}

		return elemLocation;
	}

	createSamePageLocationPreviewContent(
		anchor: HTMLElement,
		elemLocation: HTMLElement,
	): [HTMLElement, HTMLElement] | null {
		const elemToPreview = this.findPreviewContent(elemLocation);
		const clone = elemToPreview.cloneNode(true) as HTMLElement;
		for (const elem of clone.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
			const idPointedByElem = anchoredSamePageLocation(elem)!;
			if (isLocationNear(idPointedByElem, anchor)) {
				const subs = document.createElement("span");
				subs.classList.add("og-note-icon");
				elem.replaceWith(subs);
			} else {
				elem.href = "";
			}
		}

		if (!clone.textContent?.trim()) {
			return null;
		}

		return [clone, elemToPreview];
	}

	previewSamePageLocation(anchor: HTMLElement, elemNoteId: string): void {
		const elemNote = this.reader.getElementById(elemNoteId);
		if (!elemNote) {
			return;
		}
		const result = this.createSamePageLocationPreviewContent(anchor, elemNote);
		if (result) {
			const [clone, original] = result;
			const modal = PreviewModal.get();
			modal.show(clone, this.reader.pageLang || this.pubHelper.lang);
			modal.setupGoThere(() => {
				elemNote.scrollIntoView();
				original.classList.add("og-attention");
				window.setTimeout(() => {
					original.classList.remove("og-attention");
				}, 600);
			});
		}
	}
}
