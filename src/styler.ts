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

	load(paths: string[]): Promise<void> {
		this.#readerRoot.adoptedStyleSheets.splice(
			2,
			this.#readerRoot.adoptedStyleSheets.length - 2,
		);

		const promises = paths.map(path =>
			new Promise((resolve: (value: CSSStyleSheet) => void, reject) => {
				if (this.#linkedStylesheets[path]) {
					return resolve(this.#linkedStylesheets[path]);
				}

				rs.getResource(path).then(css => {
					console.debug(`loaded stylesheet ${path}: `, css);
					if (!css) {
						return reject(`Resource not found: ${path}`);
					}
					const stylesheet = new CSSStyleSheet();
					stylesheet.replace(css);
					this.#linkedStylesheets[path] = stylesheet;
					return resolve(stylesheet);
				});
			}).then(stylesheet => {
				this.#readerRoot.adoptedStyleSheets.push(stylesheet);
			}),
		);

		return Promise.allSettled(promises).then(results => {
			for (const result of results) {
				if (result.status == "rejected") {
					console.error(`Failed to load css: ${result.reason}`);
				}
			}
		});
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
