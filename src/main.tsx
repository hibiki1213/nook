import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@emobi/ui";
import "@emobi/ui/styles.css";
// Bundled fonts (local, offline): Latin/digits → Inter, Japanese → LINE Seed JP.
// (The design system names Inter but doesn't ship it, so we bundle it here.)
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import "./styles.css";
import "./accents.css";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { initAccent } from "./lib/accent";

// Stamp the saved accent before the first paint so there's no sky-blue flash.
initAccent();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="system">
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
