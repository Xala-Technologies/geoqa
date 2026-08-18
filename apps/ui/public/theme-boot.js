(function () {
  try {
    var k = "geoqa-theme";
    var s = localStorage.getItem(k);
    var t = s === "light" || s === "dark" ? s : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  } catch (e) {}
})();
