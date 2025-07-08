OgierEPUB
=========

Boring simple EPUB reader.

Definitions
-----------

### EPUB

- EPUB.
  The file format. Or, the EPUB-formatted file.
- Pub.
  Often there's tendency to call it a "book".
- Content document (Page).
  Technically, any XHTML or SVG by EPUB3 specs.
  The spine contains only content docs,
  but a content doc may not be in the spine.
- Spine.
- Metadata.

### UI

### Configuration

- Reader settings. Settings that control the reader.
- Filewise styles. Settings for the reader style that apply to the current EPUB.

TODO
----

### Testing

- [ ] SVG content - find a test case.

### Bugs

- [ ] Window size does not preserve

### Optimizations

- [ ] Menu has a large padding in front (Linux, KDE)
- [ ] Open "Wild Life" faster.

### Features

- [ ] At the bottom, add <- and ->; when showing non-linear page,
      hide those and show a "back"; when jumped here show "back" in addition.
      To support those a history (stack) needs to be added to Context.
- [ ] Fetch font from archive
- [ ] Other methods to customize reader (when UI is too narrow).
- [ ] Dark theme.
- [ ] New window?
- [ ] Welcome screen list recent files.

## App persistent state

prefs.json

```ts
type FontName = string

type PrefKey = "font.prefer" | ["font.fallbacks", FontName]
type Lang = "[zh-Hans]" | "[en]" | ...
type Key = PrefKey | [Lang, PrefKey]

// font.prefer
type Value = "sans-serif" | "serif"
// font.fallbacks
type Value = FontName[]

type Prefs = Record<Key, Value>
```

*epub-id*.json

```ts
interface PerEpubCustomization {
    baseFontSize: number;
    lineHeightScale: number;
    inlineMargin: number;
    forceLang: Lang;
    forceFont: boolean;
}
```

progress.json

```ts
interface Progress {
    positionInSpine: number;
    positionInItem: number;
}

type EpubId = string;

type Progresses = Record<EpubId, Progress>
```
