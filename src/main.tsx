import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@emobi/ui";
import "@emobi/ui/styles.css";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="light">
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
