import { FilewiseStylesKey, FilewiseStyles } from "./base";

class FilewiseStylesEditorDomContext {
	inputs: Record<FilewiseStylesKey, HTMLInputElement>;

	constructor() {
		const elem = (key: FilewiseStylesKey) =>
			document.getElementById(`og-customization-${key}`) as HTMLInputElement;
		this.inputs = {
			[FilewiseStylesKey.BaseFontSize]: elem(FilewiseStylesKey.BaseFontSize),
			[FilewiseStylesKey.LineHeightScale]: elem(FilewiseStylesKey.LineHeightScale),
			[FilewiseStylesKey.InlineMargin]: elem(FilewiseStylesKey.InlineMargin),
		};
	}

	value(key: FilewiseStylesKey): number {
		return this.inputs[key].valueAsNumber;
	}

	setValue(key: FilewiseStylesKey, value: number): void {
		this.inputs[key].value = value.toString();
	}

	set handleChange(listener: () => any) {
		for (const elem of Object.values(this.inputs)) {
			elem.onchange = listener;
		}
	}
}

/**
 * The "filewise styles" editor.
 *
 * It has a number of <input> elements in DOM that let user customize
 * the style of the EPUB being read.
 *
 * Concepts:
 *
 * - "filewise": It applies not for all EPUBs, only for the current one.
 * - "from file": styles from file are what were saved before, can be loaded after app reloads/restarts.
 * - "staged": changed in the input.
 * - "committed": applied to the reader UI.
 */
export class FilewiseStylesEditor {
	domContext: FilewiseStylesEditorDomContext;

	staged(): FilewiseStyles {
		const value = this.domContext.value;
		return {
			[FilewiseStylesKey.BaseFontSize]: value(FilewiseStylesKey.BaseFontSize),
			[FilewiseStylesKey.LineHeightScale]: value(FilewiseStylesKey.LineHeightScale),
			[FilewiseStylesKey.InlineMargin]: value(FilewiseStylesKey.InlineMargin),
		};
	}

	commitFromFile(
		savedStyles: Partial<FilewiseStyles>,
		commit: (styles: FilewiseStyles) => void,
	): void {
		let key: FilewiseStylesKey;
		for (key in this.domContext.inputs) {
			const value = savedStyles[key];
			if (value) {
				this.domContext.setValue(key, value);
			}
		}

		commit(this.staged());
	}

	setHandleChange(
		commit: (styles: FilewiseStyles) => void,
		save: (styles: FilewiseStyles) => void,
	): void {
		this.domContext.handleChange = () => {
			const styles = this.staged();
			commit(styles);
			save(styles);
		};
	}

	// Singleton
	private constructor() {
		this.domContext = new FilewiseStylesEditorDomContext();
	}
	private static self?: FilewiseStylesEditor;
	static get(): FilewiseStylesEditor {
		if (FilewiseStylesEditor.self == undefined)
			FilewiseStylesEditor.self = new FilewiseStylesEditor();
		return FilewiseStylesEditor.self;
	}
}
