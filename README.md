# Ogier EPUB Reader

Small and fast.

## TODO

- [ ] Store last read location: which line
- [ ] Fetch font from archive
- [ ] Anchors in pages
- [ ] Read progress: which nav item?
- [ ] Show cover
- [ ] Drap and drop file to open

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
