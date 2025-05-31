import { clamp, CustomStyleKey, CustomStyles, FontPrefer } from "./base";
import * as rs from "./invoke";
import { load } from "@tauri-apps/plugin-store";

export class Styler {
	#readerRoot: ShadowRoot;

	#appCss: CSSStyleSheet;
	#filewiseStylesCss: CSSStyleSheet;
	#styleElemsCss: CSSStyleSheet;
	#linkedCssResources: Record<string, CSSStyleSheet>;

	#fontPreference: FontPrefer = null;
	#filewiseStyles: CustomStyles | null = null;

	constructor(readerRoot: ShadowRoot) {
		this.#readerRoot = readerRoot;
		this.#appCss = new CSSStyleSheet();
		this.#filewiseStylesCss = new CSSStyleSheet();
		this.#styleElemsCss = new CSSStyleSheet();
		this.#linkedCssResources = {};

		this.#readerRoot.adoptedStyleSheets = [
			this.#appCss,
			this.#filewiseStylesCss,
			this.#styleElemsCss,
		];

		this.#loadAppPrefs();
	}

	// FIXME set from lib.ts and organize
	async #loadAppPrefs(): Promise<void> {
		const store = await load("prefs.json");
		const fontSubstitute = await store.get<Record<string, string>>("font.substitute");
		console.debug("font.substitute", fontSubstitute);

		let css = ":host {";
		const encoder = new TextEncoder();
		if (fontSubstitute) {
			Object.entries(fontSubstitute).forEach(([key, value]) => {
				let enc = "";
				const u8Arr = encoder.encode(key);
				u8Arr.forEach(b => {
					enc += b.toString(16).padStart(2, "0");
				});
				css += `--og-font-${enc}: ${value};\n`;
			});
		}
		css += "}";

		await this.#appCss.replace(css);
	}

	load(paths: string[]): Promise<void> {
		this.#readerRoot.adoptedStyleSheets.splice(
			3,
			this.#readerRoot.adoptedStyleSheets.length - 3,
		);

		const promises = paths.map(path =>
			new Promise((resolve: (value: CSSStyleSheet) => void, reject) => {
				if (this.#linkedCssResources[path]) {
					return resolve(this.#linkedCssResources[path]);
				}

				rs.getResource(path).then(css => {
					if (!css) {
						return reject(`Resource not found: ${path}`);
					}
					const stylesheet = new CSSStyleSheet();
					stylesheet.replace(css);
					this.#linkedCssResources[path] = stylesheet;
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

	setStyleElemsCss(css: string): void {
		this.#styleElemsCss.replace(css);
	}

	set fontPreference(value: FontPrefer) {
		this.#fontPreference = value;
		this.#setFilewiseStyleCss();
	}

	set filewiseStyles(value: CustomStyles) {
		this.#filewiseStyles = value;
		this.#setFilewiseStyleCss();
	}

	#setFilewiseStyleCss(): void {
		let hostStyle = `
            img {
                max-width: 100%;
            }
			a {
				text-decoration: none;
			}
			.og-attention {
				background-color: #fbe54e44;
			}
		`;
		if (this.#filewiseStyles) {
			const styles = this.#filewiseStyles;
			const baseFontSize = clamp(styles[CustomStyleKey.BaseFontSize], 8, 72);
			const lineHeightScale = clamp(styles[CustomStyleKey.LineHeightScale], 2, 60) / 10;
			const inlineMargin = clamp(styles[CustomStyleKey.InlineMargin], 0, 45);

			const baseFontSizeCss = baseFontSize.toFixed(2) + "px";
			const lineHeightScaleCss = lineHeightScale.toFixed(3);
			const hostLineHeightCss = (lineHeightScale * 1.25).toFixed(2);
			const inlineMarginCss = `${inlineMargin}%`;

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

		this.#filewiseStylesCss.replaceSync(hostStyle);
	}
}
