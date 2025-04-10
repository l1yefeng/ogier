import {
	fluentTab,
	fluentTabPanel,
	fluentTabs,
	provideFluentDesignSystem,
} from "@fluentui/web-components";

provideFluentDesignSystem().register(fluentTab(), fluentTabPanel(), fluentTabs());
