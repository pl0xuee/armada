// Paint the saved theme before the app loads so light themes never flash dark.
// index.html loads this as a plain file because the CSP allows no inline script.
// Keep in step with THEME_CACHE_KEY and resolveTheme in src/lib/themes.ts.
try {
  var t = localStorage.getItem("kvistcode.theme");
  if (t === "system") {
    t = window.matchMedia("(prefers-color-scheme: light)").matches ? "titanium" : "gunmetal";
  }
  if (t && /^[a-z]+$/.test(t)) document.documentElement.dataset.theme = t;
} catch (e) {}
// The same for the layout ("look"): see LOOK_KEY in src/lib/look.ts.
try {
  var l = localStorage.getItem("kvistcode.look");
  document.documentElement.dataset.look = l === "minimal" ? "minimal" : "classic";
} catch (e) {}
