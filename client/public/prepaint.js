(function () {
  try {
    var theme = localStorage.getItem("balance-theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    }
    if (localStorage.getItem("balance-font-size") === "compact") {
      document.documentElement.setAttribute("data-font-size", "compact");
    }
  } catch (_error) {
    // Storage can be disabled. The app still renders with system defaults.
  }
})();
