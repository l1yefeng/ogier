# Ogier EPUB Reader

Small and fast.

## TODO

- [ ] CODE: https://jonaskruckenberg.github.io/tauri-docs-wip/development/inter-process-communication.html#error-handling
- [ ] CSS absolute length other than px
- [ ] Store last read location: which line
- [ ] Reader style: line height
- [ ] Reader style: margin
- [ ] Fetch font from archive
- [ ] Show cover
- [ ] Anchors in pages
- [ ] Drap and drop file to open
- [ ] Read progress: which nav item?

## App persistent state

### Preferences

```js
prefs = load("prefs.json")
prefs = {
    "default": {
        "lineHeight": null,
        "fontFamily": [
            "serif",
        ],
        "fontFallback": {
            "serif": ["Noto Serif"],
            "sans-serif": ["Noto Sans"],
            "Times": ["Times New Roman"],
        },
    },
    "[zh]": {},
    "books": {},
}
```

### Progress

```js
progress = load("progress.json")
progress[bookHash] = [pageIndex, locationInPage]
```
