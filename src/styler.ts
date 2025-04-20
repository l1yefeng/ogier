import { clamp, CustomStyleKey, CustomStyles, FontPrefer } from "./base";
import * as rs from "./invoke";

export class Styler {
	#readerRoot: ShadowRoot;
	#linkedStylesheets: Record<string, CSSStyleSheet>;
	#customStylesheet: CSSStyleSheet;
	#inPageStylesheet: CSSStyleSheet;

	#fontPreference: FontPrefer = null;
	#customStyles: CustomStyles | null = null;

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
		this.#inPageStylesheet.replace(css);
	}

	set fontPreference(value: FontPrefer) {
		this.#fontPreference = value;
		this.#setCustomStylesheet();
	}

	set customStyles(value: CustomStyles) {
		this.#customStyles = value;
		this.#setCustomStylesheet();
	}

	#setCustomStylesheet(): void {
		let hostStyle = `
            img {
                max-width: 100%;
            }
		`;
		if (this.#customStyles) {
			const styles = this.#customStyles;
			const baseFontSize = clamp(styles[CustomStyleKey.BaseFontSize], 8, 72);
			const lineHeightScale = clamp(styles[CustomStyleKey.LineHeightScale], 2, 60) / 10;
			const inlineMargin = clamp(styles[CustomStyleKey.InlineMargin], 0, 500);

			const baseFontSizeCss = baseFontSize.toFixed(2) + "px";
			const lineHeightScaleCss = lineHeightScale.toFixed(3);
			const hostLineHeightCss = (lineHeightScale * 1.25).toFixed(2);
			const inlineMarginCss = `${(inlineMargin / 2).toFixed(2)}rem`;

			const host = this.#readerRoot.host as HTMLElement;
			host.style.paddingInline = inlineMarginCss;

			hostStyle += `
            :host {
                --og-line-height-scale: ${lineHeightScaleCss};
                font-size: ${baseFontSizeCss};
                line-height: ${hostLineHeightCss};
            }
			`;
		}

		if (this.#fontPreference) {
			hostStyle += `
			:host {
				font-family: ${this.#fontPreference};
			}
			`;
		}

		this.#customStylesheet.replaceSync(hostStyle);
	}
}
