export class Context {
	epubLang: string | null = null;

	private constructor() {}

	private static instance?: Context;

	static get(): Context {
		if (!Context.instance) {
			Context.instance = new Context();
		}
		return Context.instance;
	}
}
