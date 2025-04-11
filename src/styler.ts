import { clamp, CustomStyleKey, CustomStyles } from "./base";
import * as rs from "./invoke";

export class Styler {
	#readerRoot: ShadowRoot;
	#linkedStylesheets: Record<string, CSSStyleSheet>;
	#customStylesheet: CSSStyleSheet;
	#inPageStylesheet: CSSStyleSheet;

	constructor(readerRoot: ShadowRoot) {
		this.#readerRoot = readerRoot;
		this.#linkedStylesheets = {};
		this.#customStylesheet = new CSSStyleSheet();
		this.#inPageStylesheet = new CSSStyleSheet();

		this.#readerRoot.adoptedStyleSheets = [this.#inPageStylesheet, this.#customStylesheet];
	}

	// TODO (optimize) parallellize
	async load(paths: string[]): Promise<void> {
		const stylesheets = [];

		for (const path of paths) {
			if (this.#linkedStylesheets[path]) {
				stylesheets.push(this.#linkedStylesheets[path]);
				continue;
			}

			let css: string;
			try {
				css = await rs.getResource(path);
				console.debug(`loaded stylesheet ${path}: `, css);
			} catch (err) {
				console.error(`Error loading stylesheet ${path}:`, err);
				continue;
			}
			if (!css) {
				console.error(`Resource not found: ${path}`);
				continue;
			}
			const stylesheet = new CSSStyleSheet();
			stylesheet.replace(css);
			this.#linkedStylesheets[path] = stylesheet;
			stylesheets.push(stylesheet);
		}

		this.#readerRoot.adoptedStyleSheets.splice(
			2,
			this.#readerRoot.adoptedStyleSheets.length - 2,
			...stylesheets,
		);
	}

	setInPageStylesheet(css: string): void {
		this.#customStylesheet.replace(css);
	}

	setCustomStylesheet(styles: CustomStyles): void {
		const baseFontSize = clamp(styles[CustomStyleKey.BaseFontSize], 8, 72);
		const lineHeightScale = clamp(styles[CustomStyleKey.LineHeightScale], 2, 60) / 10;
		const inlineMargin = clamp(styles[CustomStyleKey.InlineMargin], 0, 500);

		const baseFontSizeCss = baseFontSize.toFixed(2) + "px";
		const lineHeightScaleCss = lineHeightScale.toFixed(3);
		const hostLineHeightCss = (lineHeightScale * 1.25).toFixed(2);
		const inlineMarginCss = `${(inlineMargin / 2).toFixed(2)}rem`;

		const host = this.#readerRoot.host as HTMLElement;
		host.style.paddingInline = inlineMarginCss;
		const hostStyle = `
            :host {
                --og-line-height-scale: ${lineHeightScaleCss};
                font-size: ${baseFontSizeCss};
                line-height: ${hostLineHeightCss};
            }
            img {
                max-width: 100%;
            }
        `;
		this.#customStylesheet.replaceSync(hostStyle);
	}
}
