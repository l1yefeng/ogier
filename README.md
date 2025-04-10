# Ogier EPUB Reader

Small and fast.

## TODO

- [ ] Improve performance when loading styles
- [ ] When toc shows, current nav point is in the center and focused
- [ ] External links
- [ ] Store last read location: which line
- [ ] Fetch font from archive
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
