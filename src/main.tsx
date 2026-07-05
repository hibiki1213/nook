import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@emobi/ui";
import "@emobi/ui/styles.css";
import "./styles.css";
import App from "./App";
import { ToastProvider } from "./components/Toast";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="system">
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
